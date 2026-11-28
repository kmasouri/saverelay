/** "Ann", "Ann and Bo", "Ann and 2 others": short enough for a tooltip or a dialog. */
export function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names[0]} and ${names.length - 1} others`
}

/** "Ann is still downloading your save (62%)", or the plural without a percentage. */
export function uploadingLine(names: string[], percent: number | null): string {
  return names.length === 1
    ? `${names[0]} is still downloading your save${percent === null ? '' : ` (${percent}%)`}`
    : `${joinNames(names)} are still downloading your save`
}
