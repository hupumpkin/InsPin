/** 焦点是不是在能打字的地方。快捷键（⌘V、空格平移）要避开输入框。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
}
