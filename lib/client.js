window.__ModuleLoader__.load({
  id: 'dsh-lan-exec',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    // First-party UI primitives: the same CodeBlock the PTC `run_code` card
    // renders with, reused directly instead of re-implemented.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Wire tool names this card owns. */
    const KEYS = ['remote_run', 'run_ts']

    /**
     * Only the pieces the ToolRow layout needs are copied: the 24px header row,
     * the 2px separator dot, the 13px summary, and the body scroll container.
     * The code surface itself is the first-party CodeBlock.
     */
    const CSS = [
      '.lanb-root{flex-direction:column;display:flex}',
      '.lanb-head{height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;transition:color .1s}',
      '.lanb-head:hover{color:var(--dsw-alias-label-secondary)}',
      '.lanb-title{font-weight:400;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none}',
      '.lanb-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
      '.lanb-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}',
      '.lanb-body{margin:4px 0 4px 4px;max-height:260px;overflow-y:auto}',
      '.lanb-ioCard{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);flex-direction:column;margin:4px 0 4px 4px;display:flex}',
      '.lanb-ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}',
      '.lanb-ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}',
      '.lanb-ioText{white-space:pre-wrap;word-break:break-word;min-width:0;margin:0;color:var(--dsw-alias-label-secondary);font:inherit}',
      '.lanb-ioText[data-error]{color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    const TAG = 'dsh-lan-exec/tool-card.css'

    /** Inject the stylesheet once per page. */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + TAG + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-lan-exec'
      tag.dataset.pluginCss = TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Read the call arguments from whichever stage the row is in.
     * @param {object} block - preparing, start or result block.
     * @returns {{code?: string, description?: string}} parsed arguments.
     */
    function readArgs(block) {
      try {
        if (block && typeof block.args === 'object' && block.args !== null) return block.args
        const raw = block && typeof block.argsRaw === 'string' ? block.argsRaw : block && block.call && block.call.argsRaw
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    }

    /**
     * Flatten a settled result's text blocks.
     * @param {object} block - result block.
     * @returns {string} rendered text.
     */
    function readOutput(block) {
      const content = block && Array.isArray(block.content) ? block.content : []
      return content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }

    /** Labels for the reused CodeBlock toolbar. */
    const CODE_LABELS = Object.freeze({
      title: 'TypeScript',
      wrapLabel: 'Wrap',
      unwrapLabel: 'Unwrap',
    })

    /**
     * A program-tool card: the PTC row shape with the PTC code surface.
     * @param {object} props - slot owner props.
     * @returns {any} React element.
     */
    function ProgramRow(props) {
      const { phase, block, toolName } = props
      const args = readArgs(block)
      const code = typeof args.code === 'string' ? args.code : ''
      const summary = typeof args.description === 'string' ? args.description : ''
      const settled = phase === 'result'
      const output = settled ? readOutput(block) : ''
      const children = [
        react.createElement(
          'div',
          { key: 'head', className: 'lanb-head' },
          react.createElement('span', { className: 'lanb-title' }, toolName === 'run_ts' ? 'Local' : 'Remote'),
          summary ? react.createElement('span', { className: 'lanb-sep' }) : null,
          react.createElement('span', { className: 'lanb-summary' }, summary),
        ),
      ]

      if (code) {
        children.push(
          react.createElement(
            'div',
            { key: 'code', className: 'lanb-body' },
            react.createElement(primitives.CodeBlock, {
              code,
              lang: 'typescript',
              copyLabel: 'Copy',
              copiedLabel: 'Copied',
              toolbarLabels: CODE_LABELS,
              className: 'lanb-codeBlock',
            }),
          ),
        )
      }
      if (output) {
        children.push(
          react.createElement(
            'div',
            { key: 'out', className: 'lanb-ioCard' },
            react.createElement(
              'div',
              { className: 'lanb-ioSection' },
              react.createElement('span', { className: 'lanb-ioLabel' }, 'Output'),
              react.createElement(
                'pre',
                { className: 'lanb-ioText', ...(block && block.isError === true ? { 'data-error': true } : {}) },
                output,
              ),
            ),
          ),
        )
      }
      return react.createElement('div', { className: 'lanb-root' }, children)
    }

    const apply = (ctx) => {
      try {
        injectStyles()
        for (const key of KEYS) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register({ name: 'tool.call.toolview', key }, ProgramRow),
          )
        }
      } catch (error) {
        // A failed card must never take the conversation down; the generic row
        // remains the fallback.
        console.error('[dsh-lan-exec] remote tool card unavailable', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
