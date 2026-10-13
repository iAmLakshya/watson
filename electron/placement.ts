export interface Rectangle { x: number; y: number; width: number; height: number; }
export function overlayBoundsForDisplay(workArea: Rectangle, current: Pick<Rectangle, 'width' | 'height'>): Rectangle {
  const width = Math.min(current.width, workArea.width); const height = Math.min(current.height, Math.max(100, workArea.height - 20));
  return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.min(36, Math.max(0, workArea.height - height)), width, height };
}
