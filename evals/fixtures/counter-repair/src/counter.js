export function countCompleted(items) {
  return items.filter((item) => item?.done === false).length
}
