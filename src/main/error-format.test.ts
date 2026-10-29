import { describe, expect, it } from 'vitest'
import { MAX_TEXT, clip, describeReason, describeRendererPayload } from './error-format'

describe('clip', () => {
  it('只接受字符串，超出上限截断', () => {
    expect(clip('abc')).toBe('abc')
    expect(clip(123)).toBeUndefined()
    expect(clip(undefined)).toBeUndefined()
    expect(clip('x'.repeat(MAX_TEXT + 50))).toHaveLength(MAX_TEXT)
  })
})

describe('describeReason', () => {
  it('Error 保留名称、信息与堆栈', () => {
    const error = new TypeError('炸了')
    const described = describeReason(error)
    expect(described.name).toBe('TypeError')
    expect(described.message).toBe('炸了')
    expect(String(described.stack)).toContain('TypeError')
  })

  it('非 Error 的值转成可读文本', () => {
    expect(describeReason('普通字符串').value).toBe('普通字符串')
    expect(describeReason({ code: 500 }).value).toBe('{"code":500}')
    expect(describeReason(undefined).value).toBe('undefined')
  })

  it('循环引用不会抛错', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => describeReason(circular)).not.toThrow()
  })
})

describe('describeRendererPayload', () => {
  it('保留我们认识的字段', () => {
    const described = describeRendererPayload({
      message: '未捕获',
      stack: 'at foo',
      source: 'App.tsx:1:1',
      extra: '不该出现'
    })
    expect(described).toEqual({ message: '未捕获', stack: 'at foo', source: 'App.tsx:1:1' })
    expect(described.extra).toBeUndefined()
  })

  it('非对象输入兜底成一条消息', () => {
    expect(describeRendererPayload('字符串错误')).toEqual({ message: '字符串错误' })
  })

  it('message 非字符串时也能读出内容', () => {
    expect(describeRendererPayload({ message: { code: 1 } })).toEqual({
      message: '{"code":1}',
      stack: undefined,
      source: undefined
    })
  })
})
