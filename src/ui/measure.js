// Text measurement for auto-fit, via one shared offscreen canvas.
// Setting ctx.font is the expensive part, so it is only set when it
// changes, and widths are cached per font + text (columns repeat a lot).
import { estimateTextWidth } from '../ai/formatApplier.js'

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
const CACHE_LIMIT = 20000
let ctx = null
let currentFont = ''
const cache = new Map()

export function measureText(text, style) {
    if (!ctx) {
        if (typeof document === 'undefined') return estimateTextWidth(text, style)
        ctx = document.createElement('canvas').getContext('2d')
    }
    const font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize || 13}px ${FONT_FAMILY}`
    const key = font + '\u0000' + text
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    if (font !== currentFont) {
        ctx.font = font
        currentFont = font
    }
    const width = ctx.measureText(String(text)).width
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, width)
    return width
}
