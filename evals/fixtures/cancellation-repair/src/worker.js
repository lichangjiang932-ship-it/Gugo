export async function runTask({ signal, work }) {
  return work(signal)
}
