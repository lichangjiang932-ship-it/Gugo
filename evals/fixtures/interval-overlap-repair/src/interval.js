export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end
}
