const diff = require("./fast-diff")

const DEFAULT_PRETTIER_CONFIG_FILENAMES = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yml",
	".prettierrc.yaml",
	".prettierrc.json5",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.ts",
	".prettierrc.mjs",
	".prettierrc.mts",
	".prettierrc.cts",
	".prettierrc.toml",
	"prettier.config.js",
	"prettier.config.cjs",
	"prettier.config.ts",
	"prettier.config.mjs",
	"prettier.config.mts",
	"prettier.config.cts"
]

const CURSOR_MARKER = String.fromCharCode(0xfffd) // Replacement character

/**
 * @param {string} executablePath
 * @param {ConstructorParameters<typeof Process>[1]} options
 * @param {string} [stdin] - Optional text to write to stdin
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
async function runAsync(executablePath, options, stdin) {
	return new Promise((resolve) => {
		const process = new Process(executablePath, options)

		let stdout = ""
		let stderr = ""

		process.onStdout((line) => (stdout += line))
		process.onStderr((line) => (stderr += line))
		process.onDidExit((code) => resolve({ code, stdout, stderr }))

		process.start()

		if (stdin) {
			const writer = process.stdin.getWriter()
			writer.write(stdin)
			writer.close()
		}
	})
}

/**
 * @param {string} dirname
 * @returns {string | undefined} path of closest prettier config
 */
function getClosestPrettierConfig(dirname) {
	const prettierConfigFilenames = DEFAULT_PRETTIER_CONFIG_FILENAMES

	let i = 0

	while (true) {
		const configRoot = nova.path.join(dirname, "../".repeat(i))

		for (const configFileName of prettierConfigFilenames) {
			const configPath = nova.path.join(configRoot, configFileName)

			if (nova.fs.stat(configPath)) return nova.path.normalize(configPath)
		}

		if (configRoot === "/")
			return // we hit top-level directory
		else if (i > 100) return // too many iterations

		i++
	}
}

/**
 * @param {{ text: string; filepath: string; configPath: string; otherArgs?: string[] }} options
 */
function prettier({ text, filepath, configPath, otherArgs = [] }) {
	const cwd = nova.path.dirname(configPath)
	const executablePath = nova.path.join(cwd, "node_modules/.bin/prettier")
	const args = ["--stdin-filepath", filepath, ...otherArgs]
	const options = { args, cwd }

	if (!nova.fs.stat(executablePath)) return

	const command = [executablePath, ...args].join(" ")
	console.log(command)

	return runAsync(executablePath, options, text)
}

/**
 * Apply a character-level diff between two strings with cursor tracking.
 *
 * @param {TextEditorEdit} edit - The Nova TextEditorEdit instance.
 * @param {string} original - Original text.
 * @param {string} formatted - Updated text.
 * @param {Range[]} selectedRanges - Array of selected ranges.
 * @returns {Range[]} - New selection ranges after formatting.
 */
function applyTextDiff(edit, original, formatted, selectedRanges) {
	if (original.includes(CURSOR_MARKER) || formatted.includes(CURSOR_MARKER)) {
		// Fall back to simple replacement
		edit.replace(new Range(0, original.length), formatted)
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

/**
 * @param {TextEditor} editor
 * @param {{ aborted?: boolean }} abortSignal
 */
async function maybeFormat(editor, abortSignal) {
	const filePath = editor.document.path
	if (!filePath) return

	const configPath = getClosestPrettierConfig(nova.path.dirname(filePath))
	if (!configPath) return

	const selectedRanges = editor.selectedRanges
	const fullRange = new Range(0, editor.document.length)
	const currentText = editor.document.getTextInRange(fullRange)

	const output = await prettier({ text: currentText, filepath: filePath, configPath })
	const guard = output?.code === 0 && currentText !== output.stdout && !abortSignal.aborted
	if (!guard) return

	const newSelections = await editor.edit((edit) =>
		applyTextDiff(edit, currentText, output.stdout, selectedRanges)
	)

	if (newSelections && newSelections.length > 0) editor.selectedRanges = newSelections

	return true
}

nova.workspace.onDidAddTextEditor((editor) => {
	/** @type {{ aborted?: boolean } | undefined } */
	let lastSignal
	editor.onWillSave(() => {
		if (lastSignal) lastSignal.aborted = true
		let nextSignal = { aborted: false }
		lastSignal = nextSignal
		maybeFormat(editor, nextSignal)
			.then((didChange) => {
				// Wait a tick so Nova finishes current save before re-saving
				if (didChange) setTimeout(() => editor.save())
			})
			.catch(console.error)
	})
})
