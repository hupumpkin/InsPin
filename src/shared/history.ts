import type { Command } from './command'
import type { ProjectGraph } from './node'

/**
 * 撤销重做栈（路线图 §1.2）。
 * 只存"已执行的命令"，当前图始终由栈顶推导，不另存快照。
 */
export class HistoryStack {
  private past: Command[] = []
  private future: Command[] = []
  private current: ProjectGraph

  constructor(initial: ProjectGraph) {
    this.current = initial
  }

  get graph(): ProjectGraph {
    return this.current
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** 执行一条新命令，并**清空重做栈**（新分支覆盖旧分支，与常规编辑器一致）。 */
  execute(command: Command): ProjectGraph {
    this.current = command.apply(this.current)
    this.past.push(command)
    this.future.length = 0
    return this.current
  }

  /** 撤销一步；没有可撤销的就不动。 */
  undo(): ProjectGraph {
    this.undoEntry()
    return this.current
  }

  /** 重做一步；没有可重做的就不动。 */
  redo(): ProjectGraph {
    this.redoEntry()
    return this.current
  }

  /** 撤销并返回撤掉的那条命令（界面据此恢复选中态等命令之外的上下文）。 */
  undoEntry(): Command | null {
    const command = this.past.pop()
    if (!command) return null
    this.current = command.revert(this.current)
    this.future.push(command)
    return command
  }

  /** 重做并返回重新执行的命令。 */
  redoEntry(): Command | null {
    const command = this.future.pop()
    if (!command) return null
    this.current = command.apply(this.current)
    this.past.push(command)
    return command
  }
}
