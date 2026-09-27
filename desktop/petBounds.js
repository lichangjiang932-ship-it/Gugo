/**
 * Keep the pet inside the work area of whatever display it is nearest.
 *
 * This is for placing and resizing the pet, not for dragging it: a drag has to
 * stay unclamped so the cursor can cross onto an adjacent monitor.
 */
export function clampPetBounds(bounds, display) {
  const area = display.workArea
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
    width: bounds.width,
    height: bounds.height,
  }
}
