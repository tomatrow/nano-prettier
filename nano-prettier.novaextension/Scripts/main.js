const diff = require("./fast-diff")

/** @type {string | undefined}  */
let globalPrettierPath

const CURSOR_MARKER = String.fromCharCode(0xfffd) // Replacement character

/**
 * @param {string} executablePath
 * @param {ConstructorParameters<typeof Process>[1]} options
 * @param {string} [stdin] - Optional text to write to stdin
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
function runAsync(executablePath, options, stdin) {
	return new Promise((resolve) => {
		const process = new Process(executablePath, options)

		let stdout = ""
		let stderr = ""

		process.onStdout((line) => (stdout += line))
		process.onStderr((line) => (stderr += line))
		process.onDidExit((code) => resolve({ code, stdout, stderr }))

		process.start()

		if (!stdin) return
		const writer = process.stdin.getWriter()
		writer.write(stdin)
		writer.close()
	})
}

/** travels up directories seeking a relative path
 * @param {string} dirname - starting dirname
 * @param {string} targetPaths - paths to check
 * @returns info on the closest path or `undefined`
 */
function getClosestPathInfo(dirname, targetPaths) {
	for (let i = 0; i <= 100; i++) {
		const currentRoot = nova.path.join(dirname, "../".repeat(i))

		for (const targetPath of targetPaths) {
			const filePath = nova.path.join(currentRoot, targetPath)
			if (nova.fs.stat(filePath))
				return {
					rootPath: nova.path.normalize(currentRoot),
					targetPath,
					filePath: nova.path.normalize(filePath)
				}
		}

		if (currentRoot === "/") return // we hit top-level directory
	}
}

/** Apply a character-level diff between two strings with cursor tracking.
 * @param {TextEditorEdit} edit - The Nova TextEditorEdit instance.
 * @param {string} original - Original text.
 * @param {string} formatted - Updated text.
 * @param {Range[]} selectedRanges - Array of selected ranges.
 * @returns {Range[]} - New selection ranges after formatting.
 */
function applyTextDiff(edit, original, formatted, selectedRanges) {
	if (original.includes(CURSOR_MARKER) || formatted.includes(CURSOR_MARKER)) {
		edit.replace(new Range(0, original.length), formatted) // Fall back to simple replacement
		return selectedRanges
	}

	// Insert cursor markers around each selection
	let originalWithCursors = ""
	let lastEnd = 0

	for (const selection of selectedRanges) {
		originalWithCursors +=
			original.slice(lastEnd, selection.start) +
			CURSOR_MARKER +
			original.slice(selection.start, selection.end) +
			CURSOR_MARKER
		lastEnd = selection.end
	}
	originalWithCursors += original.slice(lastEnd)

	const diffs = diff(originalWithCursors, formatted)

	/** @type {number[]} */
	const selections = []
	let offset = 0
	let toRemove = 0

	// Add an extra empty edit so any trailing delete is actually run
	diffs.push([diff.EQUAL, ""])

	for (const [operation, str] of diffs) {
		if (operation === diff.DELETE) {
			toRemove += str.length

			// Check if cursors are in the deleted text
			let cursorIndex = -1
			while (true) {
				cursorIndex = str.indexOf(CURSOR_MARKER, cursorIndex + 1)
				if (cursorIndex === -1) break

				const lastSelection = selections[selections.length - 1]
				if (!lastSelection || lastSelection[1] !== undefined) selections.push([offset])
				else lastSelection[1] = offset

				toRemove -= CURSOR_MARKER.length
			}
			continue
		}

		if (operation === diff.EQUAL && toRemove) edit.replace(new Range(offset, offset + toRemove), "")
		else if (operation === diff.INSERT) edit.replace(new Range(offset, offset + toRemove), str)

		toRemove = 0
		offset += str.length
	}

	// Convert selection arrays to Range objects, handling incomplete selections
	return selections.map((s) => new Range(s[0], s[1] !== undefined ? s[1] : s[0]))
}

/** @param {TextEditor} editor @param {string | undefined} lastFormattedText */
async function maybeFormat(editor, lastFormattedText) {
	const filePath = editor.document.path
	if (!filePath) return

	const wholeFileText = editor.document.getTextInRange(new Range(0, editor.document.length))
	if (lastFormattedText === wholeFileText) return

	const executablePath =
		getClosestPathInfo(nova.path.dirname(filePath), ["node_modules/.bin/prettier"])?.filePath ??
		globalPrettierPath
	if (!executablePath) return

	const args = ["--stdin-filepath", filePath]
	console.log([executablePath, ...args].join(" "))
	const prettier = await runAsync(executablePath, { args }, wholeFileText)
	if (prettier.code !== 0) throw new Error(prettier.stderr)
	if (wholeFileText === prettier.stdout) return

	const newSelections = await editor.edit((edit) =>
		applyTextDiff(edit, wholeFileText, prettier.stdout, editor.selectedRanges)
	)
	if (newSelections && newSelections.length > 0) editor.selectedRanges = newSelections

	return prettier.stdout
}

nova.workspace.onDidAddTextEditor((editor) => {
	/** @type {string | undefined} */
	let lastFormattedText
	editor.onWillSave(() => {
		maybeFormat(editor, lastFormattedText)
			.then((formattedText) => {
				if (formattedText === undefined) return
				lastFormattedText = formattedText
				setTimeout(() => editor.save())
			})
			.catch((error) => nova.workspace.showErrorMessage(error))
	})
})

module.exports.activate = async () => {
	const whichPrettier = await runAsync("/usr/bin/env", { args: ["which", "prettier"] }).catch(
		console.error
	)
	if (whichPrettier?.code === 0) globalPrettierPath = whichPrettier.stdout.trim()
}
