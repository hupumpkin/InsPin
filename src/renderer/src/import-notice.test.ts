import { describe, expect, it } from 'vitest'
import { describeClipboardImport, describeImport, describeWebImport } from './import-notice'

const ok = (importedCount: number, errors: { name: string; message: string }[] = []) =>
  ({ ok: true as const, importedCount, errors }) as Parameters<typeof describeImport>[0]

describe('describeImport', () => {
  it('全部成功时报张数', () => {
    expect(describeImport(ok(3))).toMatchObject({ tone: 'success', message: '已导入 3 张图片' })
  })

  it('一个都没进来时给出精简的失败反馈', () => {
    const notice = describeImport(ok(0, [{ name: '笔记.txt', message: '这不是图片文件（看起来是文本文件）' }]))
    expect(notice).toMatchObject({ tone: 'error', message: '导入失败：未导入「笔记.txt」', dismissible: true })
    expect(notice.message).not.toContain('0 张')
  })

  it('部分成功时先说进了几张', () => {
    expect(describeImport(ok(2, [{ name: 'a.txt', message: '这不是图片文件' }]))).toMatchObject({
      tone: 'error',
      message: '已导入 2 张图片；未导入「a.txt」'
    })
  })

  it('多个失败时带出总数', () => {
    const errors = [
      { name: 'a.txt', message: '这不是图片文件' },
      { name: 'b.pdf', message: '这不是图片文件（看起来是PDF 文档）' }
    ]
    expect(describeImport(ok(0, errors))).toMatchObject({ message: '导入失败：2 个文件未导入' })
  })

  it('只出现文件名，不出现本机路径', () => {
    const notice = describeImport(ok(0, [{ name: '笔记.txt', message: '这不是图片文件' }]))
    expect(notice.message).not.toContain('/')
  })
})

describe('describeClipboardImport', () => {
  it('成功时给出成功状态', () => {
    expect(describeClipboardImport(ok(1))).toMatchObject({ tone: 'success', message: '已导入 1 个素材' })
  })

  it('失败时用失败原因本身', () => {
    expect(describeClipboardImport(ok(0, [{ name: '剪贴板图片.png', message: '这张图片已损坏' }]))).toMatchObject({
      tone: 'error',
      message: '这张图片已损坏'
    })
  })
})

describe('describeWebImport', () => {
  it('网页图片成功落入画布时反馈成功', () => {
    expect(describeWebImport(ok(1))).toMatchObject({ tone: 'success', message: '已收集到画布' })
  })

  it('网页图片收取失败时引导用户改用智能采集', () => {
    expect(
      describeWebImport(ok(0, [{ name: '', message: '这个地址给的不是图片（拿到的是网页）' }]), 'Meta+1')
    ).toMatchObject({
      tone: 'error',
      message: '收集失败，按【⌘1】智能采集试试'
    })
  })

  it('提示里的键位跟随用户绑定', () => {
    expect(
      describeWebImport(ok(0, [{ name: '', message: '无法获取' }]), 'Alt+1')
    ).toMatchObject({
      tone: 'error',
      message: '收集失败，按【⌥1】智能采集试试'
    })
  })
})
