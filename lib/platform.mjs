/**
 * Platform selection.
 *
 * One plugin, three providers, one tool vocabulary. The tool layer asks here
 * which module to use; every provider implements the same five functions.
 */
export async function loadProvider() {
  switch (process.platform) {
    case 'win32': {
      const mod = await import('./providers/win.mjs')
      return mod
    }
    case 'darwin': {
      const mod = await import('./providers/mac.mjs')
      return mod
    }
    case 'linux': {
      const mod = await import('./providers/linux.mjs')
      return mod
    }
    default:
      return null
  }
}
