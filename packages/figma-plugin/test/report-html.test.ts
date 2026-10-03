import type { PreflightItem } from '../src/preflight'
import { PreflightReport } from '../src/report'

function capture(items: PreflightItem[], malicious = false) {
  const messages: Record<string, unknown>[] = []
  const hostile = '<img src="https://invalid.example/x" onerror="alert(1)"></script><script>alert(2)</script>&\''
  const host = new PreflightReport({ currentPage: () => ({ id: 'page:1' }), post: message => messages.push(message) })
  host.capture(42, { id: 'page:1', name: malicious ? hostile : 'Icons' }, items, {
    mode: 'console',
    rulesSource: 'project',
    project: { name: malicious ? hostile : 'Brand', revision: 9 },
    rules: { name: malicious ? hostile : '^icon-', skipPrefix: malicious ? [hostile] : [], namingMode: 'default' },
  })
  host.send({ scanId: 42, requestId: 1 })
  host.send({ scanId: 42, requestId: 2, format: 'html' })
  return { html: messages[1]!['html'] as string, document: JSON.parse(messages[0]!['json'] as string), hostile }
}

describe('offline HTML preflight document', () => {
  it('renders every captured field as inert text and has no scripts, embedded documents or network resources', () => {
    const hostile = '<img src="https://invalid.example/x" onerror="alert(1)"></script><script>alert(2)</script>&\''
    const { html } = capture([{ id: hostile, name: hostile, iconName: hostile, width: 24, height: 48, skipped: false, issues: [hostile] }], true)
    expect(html).not.toContain(hostile)
    expect(html.match(/&lt;img src=&quot;https:\/\/invalid\.example\/x&quot; onerror=&quot;alert\(1\)&quot;&gt;/g)?.length).toBeGreaterThanOrEqual(7)
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;&amp;&#39;')
    expect(html).not.toMatch(/<(?:script|img|iframe|object|embed|svg|link)\b/i)
    expect(html).not.toMatch(/\b(?:src|href)=["']/i)
    expect(html).toContain('default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'')
    expect(html).toContain('<meta name="referrer" content="no-referrer">')
  })

  it('includes drafts and all hidden results with original counts and long Unicode names', () => {
    const name = '图标🌿'.repeat(200)
    const { html, document } = capture([
      { id: '1:1', name, iconName: 'leaf', width: 16, height: 32, skipped: false, issues: ['First issue', 'Second issue'] },
      { id: '1:2', name: '_draft', iconName: null, width: 24, height: 24, skipped: true, issues: [] },
      { id: '1:3', name: 'Arrow', iconName: 'arrow', width: 24, height: 24, skipped: false, issues: [] },
    ])
    expect(document.summary).toEqual({ total: 3, checked: 2, skipped: 1, withIssues: 1, issueCount: 2, canSubmit: false })
    expect(html.match(/<article /g)).toHaveLength(3)
    expect(html).toContain(name)
    expect(html).toContain('<li>First issue</li><li>Second issue</li>')
    expect(html).toContain('<strong>3</strong><span>Total components</span>')
    expect(html).toContain('<strong>2</strong><span>Total issues</span>')
    expect(html).toContain('Icon name</dt><dd>(none)')
    expect(html).toContain('16 × 32')
    expect(html).toContain('Skip prefixes</dt><dd>None')
    expect(html).toContain('overflow-wrap: anywhere')
    expect(html).toContain('@media print')
    expect(html).not.toContain('<details')
  })

  it('distinguishes a captured empty page from a ready local preflight', () => {
    const empty = capture([]).html
    expect(empty).toContain('No components were found in this scan.')
    expect(empty).toContain('Local preflight is not ready for submission.')
    expect(empty).toContain('<strong>0</strong><span>Total components</span>')
    const ready = capture([{ id: '1:1', name: 'Arrow', iconName: 'arrow', width: 24, height: 24, skipped: false, issues: [] }]).html
    expect(ready).toContain('Local preflight passed.')
    expect(ready).toContain('Server validation is still required.')
    expect(ready).toContain('Default local naming. Duplicate names are checked on this page.')
  })
})
