/**
 * Line classifiers shared by the distiller, the verifier fingerprint and the tests.
 * Each pattern describes one kind of line seen in test runners, compilers, linters
 * and shells. Patterns only decide what to keep; they never rewrite text.
 */

/** Lines that carry a failure signal (failures, errors, assertion detail, stack-trace headers). */
export const FAIL_RE = /\b(?:fail(?:s|ed|ure|ures|ing)?|errors?|exceptions?|tracebacks?|panic(?:ked)?|assert(?:ion|ions|ed)?|expected|received|actual|not ok|typeerror|referenceerror|syntaxerror|rangeerror|cannot find|no such file|segmentation fault|timed? ?out|killed)\b|[✗✖×]|^\s*E\s{3,}/i

/** Summary lines that state zero failures; these are summaries, not failures. */
export const ZERO_RE = /\b(?:0\s+(?:failed|failures?|errors?|problems?)|(?:failed|failures?|errors?)\s*[:=]\s*0)\b/i

/** Result summaries and run metadata that must survive distillation. */
export const SUMMARY_RE = /\b\d+\s+(?:passed|failed|skipped|todo|errors?|failures?|tests?|suites?|problems?|examples?)\b|^\s*Tests?\s*:|^\s*Test Files\b|^\s*#\s*(?:tests|pass|fail|suites|duration_ms)\b|^\s*(?:ok|not ok)\b|\bexit code\b|\bran \d+\b|^={3,}.*={3,}\s*$|\bdone in\b|\bfinished in\b|\bduration\b/i

/** Lines a human must not miss even when they are not failures (security, deprecation, permissions). */
export const SAFETY_RE = /\b(?:warn(?:ing|ings)?|deprecat\w*|secur\w*|cve-\d{4}-\d+|permission|denied|unauthori[sz]ed|forbidden|credential\w*|secret\w*|vulnerab\w*|fatal)\b/i

/** Spinner frames and progress bars: rendering noise with no information. */
export const PROGRESS_RE = /^\s*[|/\\-]\s*$|^\s*\[[#=\- ]{4,}\]?\s*\d{0,3}%?\s*$|^\s*\d{1,3}%\s*\|/

/** Stack-trace frame headers in common runtimes. */
export const FRAME_RE = /^\s*(?:at\s+\S|File "[^"]+", line \d+|❯\s|-->\s)/

/** Frames inside installed libraries or the runtime itself; they rarely explain an application failure. */
export const LIB_FRAME_RE = /node_modules[\\/]|node:internal|\binternal\/|site-packages[\\/]|dist-packages[\\/]|\/usr\/lib|\/\.nvm\/|\/\.pyenv\/|<frozen |<internal\//
