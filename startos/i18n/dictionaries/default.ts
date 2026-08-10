// Plumbing dictionary for setupI18n (see ../index.ts). No translated strings
// yet - every i18n('...') call falls through to the literal English string
// passed in, which is exactly what we want until a second language exists.
export const DEFAULT_LANG = 'en_US'

const dict: Record<string, number> = {}

export default dict
