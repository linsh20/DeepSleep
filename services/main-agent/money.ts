/** Decimal HKD to integer cents, without floating-point multiplication. */
export function hkdToMinor(value: string): number {
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value.trim())) throw new Error("金额须为正数，最多两位小数")
  const [whole, fraction = ""] = value.trim().split(".")
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("金额超出范围")
  return minor
}
export function minorToHKD(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`
}

/** Normalize a user-facing HKD amount while preserving at most two decimal places. */
export function normalizeHKD(value: string | number): number {
  const text = typeof value === "number" ? String(value) : value
  return Number(minorToHKD(hkdToMinor(text)))
}

/** Convert the Main Agent's HKD-unit budget at the downstream money boundary. */
export function hkdNumberToMinor(value: number): number {
  if (!Number.isFinite(value)) throw new Error("金额须为有限 HKD 数值")
  return hkdToMinor(String(value))
}
