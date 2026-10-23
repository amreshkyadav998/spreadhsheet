// Text measurement for auto-fit, via one shared offscreen canvas.
import { estimateTextWidth } from '../ai/formatApplier.js'

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
let ctx = null

export function measureText(text, style) {
    if (!ctx) {
        if (typeof document === 'undefined') return estimateTextWidth(text, style)
        ctx = document.createElement('canvas').getContext('2d')
    }
    ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize || 13}px ${FONT_FAMILY}`
    return ctx.measureText(String(text)).width
}

export { FONT_FAMILY }
