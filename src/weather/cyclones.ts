// Cyclone warnings for a booking date. The production source is GDACS (tropical cyclone events near
// Mauritius); its API shape is UNVERIFIED here (gdacs.org was not on this build's allowed fetch list), so only
// the interface and the demo feed exist. The demo feed is what the "raise cyclone" control drives.

export type AlertLevel = "green" | "orange" | "red";

export interface CycloneAlert {
  id: string;
  name: string;
  level: AlertLevel;
  /** Inclusive ISO dates (YYYY-MM-DD) the warning covers in Mauritius. */
  from: string;
  to: string;
  source: "GDACS" | "demo";
  summary: string;
}

export interface CycloneFeed {
  alertsFor(date: string): Promise<CycloneAlert[]>;
}

export class DemoCycloneFeed implements CycloneFeed {
  readonly #alerts: CycloneAlert[] = [];

  raise(alert: Omit<CycloneAlert, "source">): CycloneAlert {
    const a: CycloneAlert = { ...alert, source: "demo" };
    this.#alerts.push(a);
    return a;
  }

  clear(): void {
    this.#alerts.length = 0;
  }

  async alertsFor(date: string): Promise<CycloneAlert[]> {
    return this.#alerts.filter((a) => a.from <= date && date <= a.to);
  }
}

/** One plain sentence on what the alert means for an outdoor booking. */
export function explainRisk(a: CycloneAlert): string {
  const what =
    a.level === "red"
      ? "a cyclone warning is in force, so outdoor trips are off and roads may close"
      : a.level === "orange"
        ? "a cyclone is close enough that strong wind and heavy rain are likely; mountain trails are unsafe"
        : "a distant cyclone may bring wind and swell; check again the day before";
  return `${a.name} (${a.level}, ${a.from} to ${a.to}, source ${a.source}): ${what}.`;
}
