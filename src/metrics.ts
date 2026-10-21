/**
 * Counters the host keeps itself.
 *
 * Neither overlay engine exposes a metrics registry, so anything an operator
 * can see about this host is something this host counted. These are rendered
 * in the Prometheus text format directly rather than through a client library,
 * because there are a dozen of them and a dependency to render a dozen numbers
 * is not worth carrying into a host whose point is to be a small, readable
 * reference.
 */
export class Metrics {
  private readonly counters = new Map<string, number>()
  private readonly gauges = new Map<string, () => number>()
  private readonly types = new Map<string, 'counter' | 'gauge' | 'histogram'>()
  private readonly histograms = new Map<
    string,
    { name: string; labels: Record<string, string>; bounds: readonly number[]; counts: number[]; sum: number; count: number }
  >()

  private static key(name: string, labels: Record<string, string> = {}): string {
    const l = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '')}"`)
      .join(',')
    return l === '' ? name : `${name}{${l}}`
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const k = Metrics.key(name, labels)
    this.counters.set(k, (this.counters.get(k) ?? 0) + by)
  }

  /**
   * Set a labelled series to 1, the Prometheus `*_build_info` idiom: the value
   * carries nothing and the LABELS are the payload.
   *
   * It exists because of a real outage. On 2026-09-23 a sibling component ran
   * a binary linking an older dependency than its manifest required, could not
   * parse what it was sent, and discarded 100% of it for ninety minutes.
   * Nothing on the host reported which version was actually loaded. Publishing
   * it makes that a query instead of an investigation.
   */
  info(name: string, labels: Record<string, string>): void {
    this.counters.set(Metrics.key(name, labels), 1)
  }

  /** Register a gauge read at scrape time. */
  gauge(name: string, read: () => number): void {
    this.gauges.set(Metrics.key(name), read)
  }

  /** Register a counter read at scrape time: a gauge rendered with TYPE counter. */
  counter(name: string, read: () => number): void {
    this.gauges.set(Metrics.key(name), read)
    this.types.set(name, 'counter')
  }

  /**
   * Create a histogram series with these upper bounds (seconds, ascending).
   * Called once per label set at startup, so every bucket exists at zero
   * before the first observation and the label set stays bounded.
   */
  histogram(name: string, labels: Record<string, string>, bounds: readonly number[]): void {
    const k = Metrics.key(name, labels)
    if (this.histograms.has(k)) return
    this.histograms.set(k, { name, labels, bounds, counts: bounds.map(() => 0), sum: 0, count: 0 })
    this.types.set(name, 'histogram')
  }

  /** Record one observation; a series never created by histogram() is ignored. */
  observe(name: string, labels: Record<string, string>, value: number): void {
    const h = this.histograms.get(Metrics.key(name, labels))
    if (h === undefined) return
    for (let i = 0; i < h.bounds.length; i++) if (value <= h.bounds[i]!) h.counts[i]!++
    h.sum += value
    h.count++
  }

  /**
   * Pre-create a series at zero. A counter that is absent until its first
   * event matches nothing in a rate() and reads identically to healthy, which
   * is exactly the silent failure an alert on it exists to catch.
   */
  preset(name: string, labels: Record<string, string> = {}): void {
    const k = Metrics.key(name, labels)
    if (!this.counters.has(k)) this.counters.set(k, 0)
  }

  render(): string {
    const lines: string[] = []
    const typed = new Set<string>()
    const type = (k: string): void => {
      const name = k.split('{')[0]!
      const t = this.types.get(name)
      if (t !== undefined && !typed.has(name)) {
        typed.add(name)
        lines.push(`# TYPE ${name} ${t}`)
      }
    }
    for (const [k, v] of [...this.counters.entries()].sort()) lines.push(`${k} ${v}`)
    for (const [k, read] of [...this.gauges.entries()].sort()) {
      try {
        const v = read()
        type(k)
        lines.push(`${k} ${v}`)
      } catch {
        // A gauge that cannot be read is omitted rather than rendered wrong.
      }
    }
    for (const [k, h] of [...this.histograms.entries()].sort()) {
      type(k)
      h.bounds.forEach((b, i) => lines.push(`${Metrics.key(`${h.name}_bucket`, { ...h.labels, le: String(b) })} ${h.counts[i]}`))
      lines.push(`${Metrics.key(`${h.name}_bucket`, { ...h.labels, le: '+Inf' })} ${h.count}`)
      lines.push(`${Metrics.key(`${h.name}_sum`, h.labels)} ${h.sum}`)
      lines.push(`${Metrics.key(`${h.name}_count`, h.labels)} ${h.count}`)
    }
    return lines.join('\n') + '\n'
  }
}
