import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { MAX_START_SOURCES } from '../shared/browser'
import { sniffImageFormat } from './mime'
import { DESIGN_SOURCE_LOGOS } from './start-page-design-logos'
import { SOURCE_LOGOS } from './start-page-logos'
import { RELAY_SOURCE_LOGOS } from './relay-source-logos'

/**
 * 左侧浏览器区域的本地起始页（新标签页 / 待机页）。
 *
 * 为什么起一个本地 http 服务而不是直接 loadFile：
 * 真实网页都需要一个正常的 http 源，浏览器会话（Cookie、localStorage）在
 * `file://` 下没有意义。这里只监听 127.0.0.1 的随机端口，不对外暴露。
 *
 * 内容与设计稿 `inspin-dom-interaction-demo.html` 的起始页一致：钉子标识 +
 * 「钉住灵感」+ 一句说明 + 六个灵感来源卡。设计稿里只有花瓣可点（其余是占位），
 * 但这里已经是真浏览器了，**六个都做成链接**，点哪个就打开哪个站点。
 */

const START_PAGE_MARK = 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJub25lIiBoZWlnaHQ9IjgwIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCA4MCA4MCIgd2lkdGg9IjgwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIj48cGF0aCBkPSJNMzUuODM0OTk5IDUuNTAxOTk5OUMzNS40Mzg5OTkgNi4wOTAwMDAyIDM0Ljk1MDAwMSA2Ljk1Njk5OTggMzQuMjIzIDguMjYyMDAwMUwzMy43ODU5OTkgOS4wNDU5OTk1QzMzLjc1NDAwMiA5LjEwNDAwMDEgMzMuNzIwMDAxIDkuMTY1IDMzLjY4NTAwMSA5LjIyNzk5OTdDMzMuMzI0MDAxIDkuODg1MDAwMiAzMi44MzIwMDEgMTAuNzc5IDMyLjAyIDExLjM5NUMzMS4xOTMwMDEgMTIuMDIzIDMwLjE5NTk5OSAxMi4yNDIgMjkuNDgzIDEyLjM5OUMyOS40MTUwMDEgMTIuNDE0IDI5LjM1IDEyLjQyOCAyOS4yODggMTIuNDQyTDI4LjQzODk5OSAxMi42MzRDMjYuODg5IDEyLjk4NSAyNS45MjMgMTMuMjEgMjUuMjczMDAxIDEzLjQzN0MyNS42NzQ5OTkgMTQuMDQgMjYuMzQ5MDAxIDE0LjgzNyAyNy40NDE5OTkgMTYuMTE1TDI4LjAyIDE2Ljc5MkMyOC4wNjMgMTYuODQxIDI4LjEwNyAxNi44OTMgMjguMTUzIDE2Ljk0NTk5OUMyOC42NDUgMTcuNTE2MDAxIDI5LjMwMTAwMSAxOC4yNzQgMjkuNjA0IDE5LjI0Nzk5OUMyOS45MDMgMjAuMjEyIDI5LjgwMiAyMS4yMDkgMjkuNzI0MDAxIDIxLjk3MTAwMUMyOS43MTY5OTkgMjIuMDQyIDI5LjcwOTk5OSAyMi4xMTEgMjkuNzAyOTk5IDIyLjE3Nzk5OUwyOS42MTU5OTkgMjMuMDhDMjkuNDU5OTk5IDI0LjY5MTk5OSAyOS4zNjQgMjUuNzM1MDAxIDI5LjM2NTk5OSAyNi40NzNDMzAuMDA3IDI2LjI0NiAzMC44ODUgMjUuODQ3IDMyLjIyMzk5OSAyNS4yMzEwMDFMMzMuMDE4MDAyIDI0Ljg2NUMzMy4wNzcgMjQuODM3OTk5IDMzLjEzOCAyNC44MDkgMzMuMjAyIDI0Ljc4MDAwMUMzMy44NjEgMjQuNDcxMDAxIDM0Ljc5NzAwMSAyNC4wMzMwMDEgMzUuODM0OTk5IDI0LjAzMzAwMUMzNi44NzQwMDEgMjQuMDMzMDAxIDM3LjgwODk5OCAyNC40NzEwMDEgMzguNDY5MDAyIDI0Ljc4MDAwMUMzOC41MzIwMDEgMjQuODA5IDM4LjU5NDAwMiAyNC44Mzc5OTkgMzguNjUyIDI0Ljg2NUwzOS40NDU5OTkgMjUuMjMxMDAxQzQwLjc4NTk5OSAyNS44NDcgNDEuNjYyOTk4IDI2LjI0NiA0Mi4zMDQwMDEgMjYuNDczQzQyLjMwNjk5OSAyNS43MzUwMDEgNDIuMjA5OTk5IDI0LjY5MTk5OSA0Mi4wNTQwMDEgMjMuMDhMNDEuOTY2OTk5IDIyLjE3Nzk5OUM0MS45NTk5OTkgMjIuMTExIDQxLjk1Mjk5OSAyMi4wNDIgNDEuOTQ1OTk5IDIxLjk3MTAwMUM0MS44Njg5OTkgMjEuMjA5IDQxLjc2Njk5OCAyMC4yMTIgNDIuMDY3MDAxIDE5LjI0Nzk5OUM0Mi4zNjk5OTkgMTguMjc0IDQzLjAyNTAwMiAxNy41MTYwMDEgNDMuNTE2OTk4IDE2Ljk0NTk5OUM0My41NjMgMTYuODkzIDQzLjYwNjk5OCAxNi44NDEgNDMuNjUwMDAyIDE2Ljc5MUw0NC4yMjgwMDEgMTYuMTE1QzQ1LjMyMTk5OSAxNC44MzcgNDUuOTk0OTk5IDE0LjA0IDQ2LjM5Njk5OSAxMy40MzdDNDUuNzQ4MDAxIDEzLjIxIDQ0Ljc4MDk5OCAxMi45ODUgNDMuMjMwOTk5IDEyLjYzNEw0Mi4zODIgMTIuNDQyQzQyLjMyIDEyLjQyOCA0Mi4yNTUwMDEgMTIuNDE0IDQyLjE4NyAxMi4zOTlDNDEuNDczOTk5IDEyLjI0MiA0MC40NzcwMDEgMTIuMDIzIDM5LjY1MDAwMiAxMS4zOTVDMzguODM4MDAxIDEwLjc3OSAzOC4zNDcgOS44ODUwMDAyIDM3Ljk4NTAwMSA5LjIyNzk5OTdDMzcuOTUwMDAxIDkuMTY1IDM3LjkxNyA5LjEwNDAwMDEgMzcuODgzOTk5IDkuMDQ1OTk5NUwzNy40NDY5OTkgOC4yNjIwMDAxQzM2LjcyMDAwMSA2Ljk1Njk5OTggMzYuMjMxOTk4IDYuMDkwMDAwMiAzNS44MzQ5OTkgNS41MDE5OTk5Wk00My4wMTY5OTggMjYuNjY3OTk5QzQzLjAxNjk5OCAyNi42Njc5OTkgNDMuMDE0OTk5IDI2LjY2NyA0My4wMTIwMDEgMjYuNjY3TDQzLjAxNjk5OCAyNi42Njc5OTlaTTI4LjY1OSAyNi42NjdDMjguNjU1MDAxIDI2LjY2NyAyOC42NTMgMjYuNjY3OTk5IDI4LjY1MyAyNi42Njc5OTlMMjguNjU5IDI2LjY2N1pNMzIuMTEyIDIuMTE1OTk5OUMzMi44MzEwMDEgMS4xNzcgMzQuMDA1MDAxIDAgMzUuODM0OTk5IDBDMzcuNjY1MDAxIDAgMzguODM5MDAxIDEuMTc3IDM5LjU1Nzk5OSAyLjExNTk5OTlDNDAuMjUgMy4wMiA0MC45NTkgNC4yOTE5OTk4IDQxLjcyOSA1LjY3NTAwMDJDNDEuNzU3OTk5IDUuNzI0OTk5OSA0MS43ODU5OTkgNS43NzYgNDEuODE0OTk5IDUuODI3MDAwMUw0Mi4yNTA5OTkgNi42MTEwMDAxQzQyLjM3NDAwMSA2LjgzMDk5OTkgNDIuNDY5MDAyIDcuMDAwOTk5OSA0Mi41NTMwMDEgNy4xNDY5OTk4QzQyLjYxMDAwMSA3LjI0NDk5OTkgNDIuNjUzOTk5IDcuMzE4OTk5OCA0Mi42ODk5OTkgNy4zNzU5OTk5QzQyLjc0NTk5OCA3LjM5MjAwMDIgNDIuODE3MDAxIDcuNDA5OTk5OCA0Mi45MDgwMDEgNy40MzIwMDAyQzQzLjA2NDk5OSA3LjQ2OTk5OTggNDMuMjQ3MDAyIDcuNTEyMDAwMSA0My40ODYgNy41NjZMNDQuMzM0IDcuNzU3OTk5OUM0NC4zOTE5OTggNy43NzA5OTk5IDQ0LjQ1MDAwMSA3Ljc4Mzk5OTkgNDQuNTA3IDcuNzk2OTk5OUM0NS45OTcwMDIgOC4xMzM5OTk4IDQ3LjM4NzAwMSA4LjQ0OCA0OC40MzcgOC44NjIwMDA1QzQ5LjU3NTAwMSA5LjMxMDAwMDQgNTAuOTQ5MDAxIDEwLjExOCA1MS40NzkgMTEuODIxQzUyIDEzLjQ5NyA1MS4zNTkwMDEgMTQuOTQ0IDUwLjcxMDk5OSAxNS45NzRDNTAuMTAyMDAxIDE2Ljk0MSA0OS4xNjE5OTkgMTguMDQwMDAxIDQ4LjEzOTk5OSAxOS4yMzM5OTlMNDcuNDUwMDAxIDIwLjA0MUM0Ny4yODY5OTkgMjAuMjMxMDAxIDQ3LjE2MTk5OSAyMC4zNzggNDcuMDU2IDIwLjUwNjAwMUM0Ni45NjkwMDIgMjAuNjExIDQ2LjkwODAwMSAyMC42ODcgNDYuODY1MDAyIDIwLjc0NTAwMUM0Ni44NzA5OTggMjAuOTMgNDYuODk1IDIxLjE5MTk5OSA0Ni45NDMwMDEgMjEuNjk1OTk5TDQ3LjA0NzAwMSAyMi43NjhDNDcuMjAyIDI0LjM2NSA0Ny4zNDQwMDIgMjUuODIzIDQ3LjI5Mjk5OSAyNi45NzJDNDcuMjQwMDAyIDI4LjE2NTAwMSA0Ni45NTggMjkuNzYxOTk5IDQ1LjU0MDAwMSAzMC44Mzc5OTlDNDQuMDgxMDAxIDMxLjk0NTk5OSA0Mi40NTEgMzEuNzMgNDEuMjkzOTk5IDMxLjM5ODAwMUM0MC4yMTIwMDIgMzEuMDg3OTk5IDM4LjkxMTk5OSAzMC40OSAzNy41MTgwMDIgMjkuODQ3QzM3LjQ2NDAwMSAyOS44MjIwMDEgMzcuNDEgMjkuNzk3MDAxIDM3LjM1NSAyOS43NzE5OTlMMzYuNTYxMDAxIDI5LjQwN0MzNi4zMzcwMDIgMjkuMzA0MDAxIDM2LjE2NiAyOS4yMjUgMzYuMDE4MDAyIDI5LjE2QzM1Ljk0NSAyOS4xMjcwMDEgMzUuODg0OTk4IDI5LjEwMTk5OSAzNS44MzQ5OTkgMjkuMDgwOTk5QzM1Ljc4NSAyOS4xMDE5OTkgMzUuNzI0OTk4IDI5LjEyNzAwMSAzNS42NTIgMjkuMTZDMzUuNTA0MDAyIDI5LjIyNSAzNS4zMzMgMjkuMzA0MDAxIDM1LjEwOTAwMSAyOS40MDdMMzQuMzE0OTk5IDI5Ljc3MTk5OUMzNC4yNjEwMDIgMjkuNzk3MDAxIDM0LjIwNjAwMSAyOS44MjIwMDEgMzQuMTUyIDI5Ljg0N0MzMi43NTc5OTkgMzAuNDkgMzEuNDU4IDMxLjA4Nzk5OSAzMC4zNzU5OTkgMzEuMzk4MDAxQzI5LjIxOTk5OSAzMS43MyAyNy41ODkwMDEgMzEuOTQ1OTk5IDI2LjEyOTk5OSAzMC44Mzc5OTlDMjQuNzEyIDI5Ljc2MTk5OSAyNC40MzEgMjguMTY1MDAxIDI0LjM3NzAwMSAyNi45NzJDMjQuMzI2IDI1LjgyMyAyNC40NjggMjQuMzY1IDI0LjYyMjk5OSAyMi43NjhDMjQuNjI4IDIyLjcxMSAyNC42MzQwMDEgMjIuNjU1MDAxIDI0LjYzOSAyMi41OThMMjQuNzI2OTk5IDIxLjY5NTk5OUMyNC43NzU5OTkgMjEuMTkxOTk5IDI0Ljc5OSAyMC45MyAyNC44MDUgMjAuNzQ1MDAxQzI0Ljc2MTk5OSAyMC42ODcgMjQuNzAyIDIwLjYxMSAyNC42MTQgMjAuNTA2MDAxQzI0LjUwNzk5OSAyMC4zNzggMjQuMzgyOTk5IDIwLjIzMTAwMSAyNC4yMTk5OTkgMjAuMDQxTDIzLjY0MiAxOS4zNjVDMjMuNjA0IDE5LjMyMDk5OSAyMy41NjY5OTkgMTkuMjc3IDIzLjUzMDAwMSAxOS4yMzM5OTlDMjIuNTA5MDAxIDE4LjA0MDAwMSAyMS41NjkgMTYuOTQxIDIwLjk1OTk5OSAxNS45NzRDMjAuMzEyIDE0Ljk0NCAxOS42NyAxMy40OTcgMjAuMTkxIDExLjgyMUMyMC43MjEwMDEgMTAuMTE4IDIyLjA5NDk5OSA5LjMxMDAwMDQgMjMuMjMzIDguODYyMDAwNUMyNC4yODMwMDEgOC40NDggMjUuNjczIDguMTMzOTk5OCAyNy4xNjMgNy43OTY5OTk5QzI3LjIxOTk5OSA3Ljc4Mzk5OTkgMjcuMjc4IDcuNzcwOTk5OSAyNy4zMzYgNy43NTc5OTk5TDI4LjE4NDk5OSA3LjU2NkMyOC40MjMgNy41MTIwMDAxIDI4LjYwNjAwMSA3LjQ2OTk5OTggMjguNzYxOTk5IDcuNDMyMDAwMkMyOC44NTMwMDEgNy40MDk5OTk4IDI4LjkyNCA3LjM5MjAwMDIgMjguOTggNy4zNzU5OTk5QzI5LjAxNjAwMSA3LjMxODk5OTggMjkuMDU5OTk5IDcuMjQ0OTk5OSAyOS4xMTcwMDEgNy4xNDY5OTk4QzI5LjIwMSA3LjAwMDk5OTkgMjkuMjk2IDYuODMwOTk5OSAyOS40MTkwMDEgNi42MTEwMDAxTDI5Ljg1NjAwMSA1LjgyNzAwMDFDMjkuODg0MDAxIDUuNzc2IDI5LjkxMjAwMSA1LjcyNDk5OTkgMjkuOTQxIDUuNjc1MDAwMkMzMC43MTEgNC4yOTE5OTk4IDMxLjQyIDMuMDIgMzIuMTEyIDIuMTE1OTk5OVpNOS4xNjgwMDAyIDIzLjE3MjAwMUM5LjM0MiAyMy40OTMgOS43MTE5OTk5IDI0LjE0ODAwMSAxMC4zMiAyNC42MTAwMDFDMTAuOTczIDI1LjEwNjAwMSAxMS43NTcgMjUuMjcxIDEyLjA4MyAyNS4zMzkwMDFDMTIuMTE1IDI1LjM0NjAwMSAxMi4xNDMgMjUuMzUxOTk5IDEyLjE2NiAyNS4zNTdMMTIuMjM1IDI1LjM3Mjk5OUwxMi4xMjYgMjUuNUMxMi4xMDkgMjUuNTIgMTIuMDg5IDI1LjU0Mjk5OSAxMi4wNjYgMjUuNTY5QzExLjgzNyAyNS44MjkgMTEuMzI2IDI2LjQxMDk5OSAxMS4wOTEgMjcuMTY5MDAxQzEwLjg1OCAyNy45MTcgMTAuOTQyIDI4LjY4MzAwMSAxMC45OCAyOS4wMzMwMDFDMTAuOTg0IDI5LjA2ODAwMSAxMC45ODcgMjkuMSAxMC45OSAyOS4xMjU5OTlMMTAuOTk0IDI5LjE2M0MxMC42NzkgMjkuMDEzIDkuOTY3IDI4LjY4MzAwMSA5LjE2ODAwMDIgMjguNjgzMDAxQzguMzY5OTk5OSAyOC42ODMwMDEgNy42NTcwMDAxIDI5LjAxMyA3LjM0Mjk5OTkgMjkuMTYzTDcuMzQ3MDAwMSAyOS4xMjU5OTlDNy4zNDkgMjkuMSA3LjM1MzAwMDIgMjkuMDY4MDAxIDcuMzU2OTk5OSAyOS4wMzMwMDFDNy4zOTUgMjguNjgzMDAxIDcuNDc5MDAwMSAyNy45MTcgNy4yNDU5OTk4IDI3LjE2OTAwMUM3LjAxMDAwMDIgMjYuNDEwOTk5IDYuNSAyNS44MjkgNi4yNzA5OTk5IDI1LjU2OUM2LjI0ODAwMDEgMjUuNTQyOTk5IDYuMjI4MDAwMiAyNS41MiA2LjIxMSAyNS41TDYuMTAyMDAwMiAyNS4zNzI5OTlMNi4xNzEgMjUuMzU3QzYuMTkzOTk5OCAyNS4zNTE5OTkgNi4yMjEwMDAyIDI1LjM0NjAwMSA2LjI1NDAwMDIgMjUuMzM5MDAxQzYuNTc5OTk5OSAyNS4yNzEgNy4zNjM5OTk4IDI1LjEwNjAwMSA4LjAxNzAwMDIgMjQuNjEwMDAxQzguNjIzOTk5NiAyNC4xNDgwMDEgOC45OTQ5OTk5IDIzLjQ5MyA5LjE2ODAwMDIgMjMuMTcyMDAxWk01LjE0NTk5OTkgMjAuODI3OTk5TDUuNjE5IDIyLjkxOTAwMUw1LjE0NTk5OTkgMjAuODI3OTk5Wk03LjE4OTAwMDEgMzEuMjgyQzcuMTg5MDAwMSAzMS4yODIgNy4xODkwMDAxIDMxLjI3ODk5OSA3LjE4ODAwMDIgMzEuMjc1TDcuMTg5MDAwMSAzMS4yODJaTTExLjE0OCAzMS4yNzVDMTEuMTQ4IDMxLjI3ODk5OSAxMS4xNDcgMzEuMjgyIDExLjE0OCAzMS4yODJMMTEuMTQ4IDMxLjI3NVpNNi4zMTUwMDAxIDE4LjIxNUM2Ljc0MyAxNy42NTUwMDEgNy42NTM5OTk4IDE2LjY2NyA5LjE2ODAwMDIgMTYuNjY3QzEwLjY4MyAxNi42NjcgMTEuNTkzIDE3LjY1NTAwMSAxMi4wMjIgMTguMjE1QzEyLjQyNiAxOC43NDIwMDEgMTIuODIxIDE5LjQ1MiAxMy4xODUgMjAuMTA2MDAxQzEzLjIwNyAyMC4xNDM5OTkgMTMuMjI4IDIwLjE4MzAwMSAxMy4yNSAyMC4yMjJMMTMuNDEyIDIwLjUxM0wxMy42OTQgMjAuNTc2QzEzLjczNyAyMC41ODYgMTMuNzggMjAuNTk2MDAxIDEzLjgyMyAyMC42MDYwMDFDMTQuNTI2IDIwLjc2NCAxNS4zMSAyMC45NDEgMTUuOTI4IDIxLjE4NDk5OUMxNi42MzEwMDEgMjEuNDYyIDE3Ljc1MjAwMSAyMi4wNjY5OTkgMTguMTg0IDIzLjQ1NTk5OUMxOC42MDggMjQuODE4MDAxIDE4LjA1Njk5OSAyNS45NDUgMTcuNjY0IDI2LjU2OUMxNy4zMDkgMjcuMTMyOTk5IDE2Ljc4MzAwMSAyNy43NDc5OTkgMTYuMjk5OTk5IDI4LjMxMkMxNi4yNzE5OTkgMjguMzQ0OTk5IDE2LjI0MyAyOC4zNzggMTYuMjE1IDI4LjQxMDk5OUwxNS45NzIgMjguNjk1OTk5TDE2LjAxIDI5LjA5NDk5OUMxNi4wMTQ5OTkgMjkuMTM4IDE2LjAxODk5OSAyOS4xODE5OTkgMTYuMDIzMDAxIDI5LjIyNkMxNi4wOTcgMjkuOTgxMDAxIDE2LjE3NjAwMSAzMC43OTIgMTYuMTQ2IDMxLjQ1OEMxNi4xMTQgMzIuMTY3IDE1LjkzOSAzMy40NDkwMDEgMTQuNzc3IDM0LjMzMTAwMUMxMy41NzMgMzUuMjQ0OTk5IDEyLjI2MiAzNS4wMjEgMTEuNTU0IDM0LjgxODAwMUMxMC45MTcgMzQuNjM0OTk4IDEwLjE4NSAzNC4yOTggOS41Mjc5OTk5IDMzLjk5Mzk5OUM5LjQ4NzAwMDUgMzMuOTc2MDAyIDkuNDQ2MDAwMSAzMy45NTcwMDEgOS40MDYwMDAxIDMzLjkzOEw5LjE2ODAwMDIgMzMuODI4OTk5TDguOTMwOTk5OCAzMy45MzhDOC44OTA5OTk4IDMzLjk1NzAwMSA4Ljg1MDAwMDQgMzMuOTc2MDAyIDguODA5IDMzLjk5Mzk5OUM4LjE1MjAwMDQgMzQuMjk4IDcuNDIwMDAwMSAzNC42MzQ5OTggNi43ODMgMzQuODE4MDAxQzYuMDczOTk5OSAzNS4wMjEgNC43NjM5OTk5IDM1LjI0NDk5OSAzLjU1OTk5OTkgMzQuMzMxMDAxQzIuMzk3MDAwMSAzMy40NDkwMDEgMi4yMjE5OTk5IDMyLjE2NyAyLjE5MSAzMS40NThDMi4xNjEgMzAuNzkyIDIuMjQgMjkuOTgxMDAxIDIuMzEzOTk5OSAyOS4yMjZDMi4zMTgwMDAxIDI5LjE4MTk5OSAyLjMyMiAyOS4xMzggMi4zMjYgMjkuMDk0OTk5TDIuMzY1IDI4LjY5NTk5OUwyLjEyMiAyOC40MTA5OTlDMi4wOTQwMDAxIDI4LjM3OCAyLjA2NTAwMDEgMjguMzQ0OTk5IDIuMDM2OTk5OSAyOC4zMTJDMS41NTQgMjcuNzQ3OTk5IDEuMDI4IDI3LjEzMjk5OSAwLjY3Mjk5OTk4IDI2LjU2OUMwLjI4IDI1Ljk0NSAtMC4yNzEgMjQuODE4MDAxIDAuMTUzIDIzLjQ1NTk5OUMwLjU4NDk5OTk4IDIyLjA2Njk5OSAxLjcwNiAyMS40NjIgMi40MDg5OTk5IDIxLjE4NDk5OUMzLjAyNyAyMC45NDEgMy44MDk5OTk5IDIwLjc2NCA0LjUxMyAyMC42MDYwMDFDNC41NTcwMDAyIDIwLjU5NjAwMSA0LjU5OTk5OTkgMjAuNTg2IDQuNjQzMDAwMSAyMC41NzZMNC45MjUwMDAyIDIwLjUxM0w1LjA4Njk5OTkgMjAuMjIyQzUuMTA3OTk5OCAyMC4xODMwMDEgNS4xMzAwMDAxIDIwLjE0Mzk5OSA1LjE1MiAyMC4xMDYwMDFDNS41MTQ5OTk5IDE5LjQ1MiA1LjkxMDk5OTggMTguNzQyMDAxIDYuMzE1MDAwMSAxOC4yMTVaTTYyLjUwMTk5OSAyMy4xNzIwMDFDNjIuNjc1OTk5IDIzLjQ5MyA2My4wNDYwMDEgMjQuMTQ4MDAxIDYzLjY1Mzk5OSAyNC42MTAwMDFDNjQuMzA2OTk5IDI1LjEwNjAwMSA2NS4wODk5OTYgMjUuMjcxIDY1LjQxNiAyNS4zMzkwMDFDNjUuNDQ4OTk3IDI1LjM0NjAwMSA2NS40NzY5OTcgMjUuMzUxOTk5IDY1LjQ5OTAwMSAyNS4zNTdMNjUuNTY4MDAxIDI1LjM3Mjk5OUw2NS40NTkgMjUuNUM2NS40NDIwMDEgMjUuNTIgNjUuNDIxOTk3IDI1LjU0Mjk5OSA2NS4zOTkwMDIgMjUuNTY5QzY1LjE3MDk5OCAyNS44MjkgNjQuNjYwMDA0IDI2LjQxMDk5OSA2NC40MjQwMDQgMjcuMTY5MDAxQzY0LjE5MTAwMiAyNy45MTcgNjQuMjc1MDAyIDI4LjY4MzAwMSA2NC4zMTQwMDMgMjkuMDMzMDAxQzY0LjMxNzAwMSAyOS4wNjgwMDEgNjQuMzIwOTk5IDI5LjEgNjQuMzIyOTk4IDI5LjEyNTk5OUw2NC4zMjcwMDMgMjkuMTYzQzY0LjAxMyAyOS4wMTMgNjMuMjk5OTk5IDI4LjY4MzAwMSA2Mi41MDE5OTkgMjguNjgzMDAxQzYxLjcwMzk5OSAyOC42ODMwMDEgNjAuOTkxMDAxIDI5LjAxMyA2MC42NzY5OTggMjkuMTYzTDYwLjY4IDI5LjEyNTk5OUM2MC42ODI5OTkgMjkuMSA2MC42ODYwMDEgMjkuMDY4MDAxIDYwLjY4OTk5OSAyOS4wMzMwMDFDNjAuNzI4MDAxIDI4LjY4MzAwMSA2MC44MTIgMjcuOTE3IDYwLjU4MDAwMiAyNy4xNjkwMDFDNjAuMzQ0MDAyIDI2LjQxMDk5OSA1OS44MzMgMjUuODI5IDU5LjYwNCAyNS41NjlDNTkuNTgxMDAxIDI1LjU0Mjk5OSA1OS41NjEwMDEgMjUuNTIgNTkuNTQzOTk5IDI1LjVMNTkuNDM1MDAxIDI1LjM3Mjk5OUw1OS41MDQwMDIgMjUuMzU3QzU5LjUyNyAyNS4zNTE5OTkgNTkuNTU1IDI1LjM0NjAwMSA1OS41ODcwMDIgMjUuMzM5MDAxQzU5LjkxMjk5OCAyNS4yNzEgNjAuNjk2OTk5IDI1LjEwNjAwMSA2MS4zNDk5OTggMjQuNjEwMDAxQzYxLjk1OCAyNC4xNDgwMDEgNjIuMzI3OTk5IDIzLjQ5MyA2Mi41MDE5OTkgMjMuMTcyMDAxWk02MC41MjI5OTkgMzEuMjgyQzYwLjUyMjk5OSAzMS4yODIgNjAuNTIyOTk5IDMxLjI4MDAwMSA2MC41MjE5OTkgMzEuMjc1TDYwLjUyMjk5OSAzMS4yODJaTTU5LjY0Nzk5OSAxOC4yMTVDNjAuMDc3IDE3LjY1NTAwMSA2MC45ODcgMTYuNjY3IDYyLjUwMTk5OSAxNi42NjdDNjQuMDE1OTk5IDE2LjY2NyA2NC45MjcwMDIgMTcuNjU1MDAxIDY1LjM1NjAwMyAxOC4yMTVDNjUuNzU5MDAzIDE4Ljc0MjAwMSA2Ni4xNTQ5OTkgMTkuNDUyIDY2LjUxODk5NyAyMC4xMDYwMDFDNjYuNTQwMDAxIDIwLjE0Mzk5OSA2Ni41NjE5OTYgMjAuMTgzMDAxIDY2LjU4MyAyMC4yMjJMNjYuNzQ1MDAzIDIwLjUxM0w2Ny4wMjcgMjAuNTc2QzY3LjA3IDIwLjU4NiA2Ny4xMTI5OTkgMjAuNTk2MDAxIDY3LjE1Njk5OCAyMC42MDYwMDFDNjcuODYwMDAxIDIwLjc2NCA2OC42NDI5OTggMjAuOTQxIDY5LjI2MTAwMiAyMS4xODQ5OTlDNjkuOTYzOTk3IDIxLjQ2MiA3MS4wODQ5OTkgMjIuMDY2OTk5IDcxLjUxNjk5OCAyMy40NTU5OTlDNzEuOTQxMDAyIDI0LjgxODAwMSA3MS4zODk5OTkgMjUuOTQ1IDcwLjk5NzAwMiAyNi41NjlDNzAuNjQxOTk4IDI3LjEzMjk5OSA3MC4xMTU5OTcgMjcuNzQ3OTk5IDY5LjYzNDAwMyAyOC4zMTJDNjkuNjA1MDAzIDI4LjM0NDk5OSA2OS41NzcwMDMgMjguMzc4IDY5LjU0Nzk5NyAyOC40MTA5OTlMNjkuMzA1IDI4LjY5NTk5OUw2OS4zNDQwMDIgMjkuMDk0OTk5QzY5LjM0OCAyOS4xMzggNjkuMzUxOTk3IDI5LjE4MTk5OSA2OS4zNTcwMDIgMjkuMjI1QzY5LjQzIDI5Ljk4MTAwMSA2OS41MDkwMDMgMzAuNzkyIDY5LjQ3ODk5NiAzMS40NThDNjkuNDQ3OTk4IDMyLjE2NyA2OS4yNzMwMDMgMzMuNDQ5MDAxIDY4LjExMDAwMSAzNC4zMzEwMDFDNjYuOTA1OTk4IDM1LjI0NDk5OSA2NS41OTYwMDEgMzUuMDIxIDY0Ljg4NzAwMSAzNC44MTgwMDFDNjQuMjUgMzQuNjM0OTk4IDYzLjUxOTAwMSAzNC4yOTggNjIuODYxIDMzLjk5NDk5OUM2Mi44MiAzMy45NzYwMDIgNjIuNzc4OTk5IDMzLjk1NzAwMSA2Mi43Mzg5OTggMzMuOTM4TDYyLjUwMTk5OSAzMy44Mjg5OTlMNjIuMjY0IDMzLjkzOEM2Mi4yMjM5OTkgMzMuOTU3MDAxIDYyLjE4Mzk5OCAzMy45NzYwMDIgNjIuMTQzMDAyIDMzLjk5Mzk5OUM2MS40ODUwMDEgMzQuMjk4IDYwLjc1Mjk5OCAzNC42MzQ5OTggNjAuMTE2MDAxIDM0LjgxODAwMUM1OS40MDgwMDEgMzUuMDIxIDU4LjA5NyAzNS4yNDQ5OTkgNTYuODk0MDAxIDM0LjMzMTAwMUM1NS43MzA5OTkgMzMuNDQ5MDAxIDU1LjU1NiAzMi4xNjcgNTUuNTIzOTk4IDMxLjQ1OEM1NS40OTQ5OTkgMzAuNzkyIDU1LjU3MzAwMiAyOS45ODEwMDEgNTUuNjQ2OTk5IDI5LjIyNkM1NS42NTEwMDEgMjkuMTgxOTk5IDU1LjY1NTk5OCAyOS4xMzggNTUuNjYgMjkuMDk0OTk5TDU1LjY5ODAwMiAyOC42OTU5OTlMNTUuNDU1MDAyIDI4LjQxMDk5OUM1NS40MjY5OTggMjguMzc4IDU1LjM5Nzk5OSAyOC4zNDQ5OTkgNTUuMzY5OTk5IDI4LjMxMkM1NC44ODcwMDEgMjcuNzQ3OTk5IDU0LjM2MSAyNy4xMzI5OTkgNTQuMDA2MDAxIDI2LjU2OUM1My42MTI5OTkgMjUuOTQ1IDUzLjA2MyAyNC44MTgwMDEgNTMuNDg2IDIzLjQ1NTk5OUM1My45MTc5OTkgMjIuMDY2OTk5IDU1LjAzOTAwMSAyMS40NjIgNTUuNzQyMDAxIDIxLjE4NDk5OUM1Ni4zNjAwMDEgMjAuOTQxIDU3LjE0NDAwMSAyMC43NjQgNTcuODQ3IDIwLjYwNjAwMUM1Ny44ODk5OTkgMjAuNTk2MDAxIDU3LjkzMzk5OCAyMC41ODYgNTcuOTc2MDAyIDIwLjU3Nkw1OC4yNTc5OTkgMjAuNTEzTDU4LjQxOTk5OCAyMC4yMjJDNTguNDQyMDAxIDIwLjE4MzAwMSA1OC40NjMwMDEgMjAuMTQzOTk5IDU4LjQ4NTAwMSAyMC4xMDYwMDFDNTguODQ4OTk5IDE5LjQ1MiA1OS4yNDM5OTkgMTguNzQyMDAxIDU5LjY0Nzk5OSAxOC4yMTVaTTY0LjQ4MjAwMiAzMS4yNzVDNjQuNDgxMDAzIDMxLjI3ODk5OSA2NC40ODEwMDMgMzEuMjgyIDY0LjQ4MTAwMyAzMS4yODJMNjQuNDgyMDAyIDMxLjI3NVpNMjQuNzgxIDQzLjk5Mzk5OUMzMS4wMDA5OTkgNDIuNzg5MDAxIDM3LjY1OSA0My4wNTg5OTggNDMuMDQ2MDAxIDQ2LjI3Mjk5OUM0My44MDMwMDEgNDYuNzIzOTk5IDQ0LjUxMjAwMSA0Ny4yODU5OTkgNDUuMTMxMDAxIDQ3Ljk4MDk5OUM0Ni4zODM5OTkgNDkuMzg5IDQ3LjAzMDk5OCA1MS4xMzggNDcuMDYxMDAxIDUyLjg5MDk5OUM0Ny42OTkwMDEgNTIuNDggNDguMzM4MDAxIDUyLjAyMjk5OSA0OC45ODYgNTEuNTMzMDAxTDU1LjAwOTk5OCA0Ni45ODMwMDJDNTguMDI2MDAxIDQ0LjcwNTAwMiA2Mi40MDgwMDEgNDQuNzA1MDAyIDY1LjQyMjk5NyA0Ni45ODE5OThDNjguMjA5OTk5IDQ5LjA4NTk5OSA2OS4zMjA5OTkgNTIuODYyIDY3LjMyNTk5NiA1Ni4wNTg5OThDNjUuOTA3OTk3IDU4LjMzMjAwMSA2My43NzI5OTkgNjEuNDc0OTk4IDYxLjU5OTk5OCA2My40ODdDNTkuNDAzOTk5IDY1LjUyMjAwMyA1Ni4yNzggNjcuMjMyMDAyIDUzLjkxMjk5OCA2OC4zNzMwMDFDNTEuMDQyIDY5Ljc1OTAwMyA0Ny45Mzk5OTkgNzAuNTI2MDAxIDQ0LjkyNCA3MS4wMTRDMzguNzU5OTk4IDcyLjAxMTAwMiAzMi4zNDcgNzEuODU5MDAxIDI2LjI1MjAwMSA3MC42MDI5OTdDMjMuMTM2OTk5IDY5Ljk2MDk5OSAxOS45IDY5LjYyNzk5OCAxNi43MDIgNjkuNjI3OTk4TDkuMTY4MDAwMiA2OS42Mjc5OThDNy43ODgwMDAxIDY5LjYyNzk5OCA2LjY2ODAwMDIgNjguNTA5MDAzIDYuNjY4MDAwMiA2Ny4xMjc5OThDNi42NjgwMDAyIDY1Ljc0NzAwMiA3Ljc4ODAwMDEgNjQuNjI3OTk4IDkuMTY4MDAwMiA2NC42Mjc5OThMMTYuNzAyIDY0LjYyNzk5OEMyMC4yNDIwMDEgNjQuNjI3OTk4IDIzLjgxNjk5OSA2NC45OTcwMDIgMjcuMjYxIDY1LjcwNjAwMUMzMi43NjY5OTggNjYuODQxMDAzIDM4LjU2OSA2Ni45NzY5OTcgNDQuMTI1IDY2LjA3ODAwM0M0Ni44ODkgNjUuNjMwOTk3IDQ5LjQ2OTAwMiA2NC45NjcwMDMgNTEuNzQwMDAyIDYzLjg2OTk5OUM1NC4wMTgwMDIgNjIuNzcxIDU2LjU3ODk5OSA2MS4zMjMwMDIgNTguMjAyOTk5IDU5LjgxOUM1OS44NDQwMDIgNTguMjk4IDYxLjY4MTk5OSA1NS42NiA2My4wODQgNTMuNDEyOTk4QzYzLjUwNyA1Mi43MzQwMDEgNjMuNDQ4MDAyIDUxLjc1NjAwMSA2Mi40MSA1MC45NzJDNjEuMTc4MDAxIDUwLjA0MSA1OS4yNTYwMDEgNTAuMDQyIDU4LjAyMzk5OCA1MC45NzJMNTIgNTUuNTIyOTk5QzQ5LjU5NTAwMSA1Ny4zMzkwMDEgNDYuNjM0OTk4IDU5LjI4MzAwMSA0Mi45NjQwMDEgNTkuODY4OTk5QzQyLjU5NDAwMiA1OS45MjgwMDEgNDIuMjA4IDU5Ljk4MTk5OCA0MS44MDc5OTkgNjAuMDI4OTk5QzQxLjYxNzAwMSA2MC4wNjM5OTkgNDEuNDE3OTk5IDYwLjA4NzAwMiA0MS4yMTMwMDEgNjAuMDk0MDAyQzM5LjMzODAwMSA2MC4yODA5OTggMzcuMTY3OTk5IDYwLjMyNDAwMSAzNC43NzI5OTkgNjAuMDk4QzMzLjM5Nzk5OSA1OS45Njc5OTkgMzIuMzg5IDU4Ljc0ODAwMSAzMi41MTkwMDEgNTcuMzc0MDAxQzMyLjY0ODk5OCA1NS45OTkwMDEgMzMuODY4IDU0Ljk5MDAwMiAzNS4yNDMgNTUuMTE5OTk5QzM3LjMzNCA1NS4zMTcwMDEgMzkuMjEwOTk5IDU1LjI3Mzk5OCA0MC44MDMwMDEgNTUuMTEwMDAxQzQwLjgzNDk5OSA1NS4xMDY5OTggNDAuODY3MDAxIDU1LjEwNCA0MC44OTg5OTggNTUuMDk5OTk4QzQwLjk2NiA1NS4wNjIgNDEuMDY3MDAxIDU0Ljk5MTAwMSA0MS4yMDAwMDEgNTQuODc1QzQyLjI2NDk5OSA1My45NDUgNDIuMzYwMDAxIDUyLjM4OSA0MS4zOTYgNTEuMzA2QzQxLjE1MiA1MS4wMzIwMDEgNDAuODUxMDAyIDUwLjc4NSA0MC40ODUwMDEgNTAuNTY3MDAxQzM2LjU0OCA0OC4yMTc5OTkgMzEuMjg5IDQ3LjgyNiAyNS43MzIgNDguOTAzQzIwLjIwNzAwMSA0OS45NzMgMTQuNzE4IDUyLjQzODk5OSAxMC42MTUgNTUuMzQ4OTk5QzkuNDg3OTk5OSA1Ni4xNDc5OTkgNy45MjggNTUuODgyIDcuMTI5MDAwMiA1NC43NTYwMDFDNi4zMjk5OTk5IDUzLjYzMDAwMSA2LjU5NjAwMDIgNTIuMDY5IDcuNzIyMDAwMSA1MS4yN0MxMi4zODMgNDcuOTY1IDE4LjUzMDAwMSA0NS4yMDUwMDIgMjQuNzgxIDQzLjk5Mzk5OVoiIGZpbGw9IiM3NzRhZmYiIGZpbGwtcnVsZT0iZXZlbm9kZCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNC4xNjUsIDQuMTY3KSIvPjwvc3ZnPgo='

/** 设计稿 42:2777「起始页组件」里的六个灵感来源，顺序与设计稿一致。 */
const SOURCES: { key: string; name: string; url: string }[] = [
  { key: 'dribbble', name: 'Dribbble', url: 'https://dribbble.com/' },
  { key: 'behance', name: 'Behance', url: 'https://www.behance.net/' },
  { key: 'pinterest', name: 'Pinterest', url: 'https://www.pinterest.com/' },
  { key: 'x', name: 'X', url: 'https://x.com/' },
  { key: 'pixiv', name: 'Pixiv', url: 'https://www.pixiv.net/' },
  { key: 'artstation', name: 'ArtStation', url: 'https://www.artstation.com/' }
]

/** 最多 12 个收藏站点：宽屏两排、窄屏四排。 */
const MAX_SOURCES = MAX_START_SOURCES

/** 被新默认列表替换掉的旧默认站点；升级时连同旧顺序一起清掉。 */
const REPLACED_DEFAULT_HOSTS = new Set([
  'huaban.com',
  'www.zcool.com.cn',
  'www.xiaohongshu.com',
  'dribbble.com',
  'www.pinterest.com',
  'www.behance.net',
  'www.artstation.com',
  'www.pixiv.net'
])

/** 默认站点的 logo 优先用设计稿这套；自定义站点走 thumbnail。 */
function logoFor(key: string): string {
  return DESIGN_SOURCE_LOGOS[key] ?? RELAY_SOURCE_LOGOS[key] ?? SOURCE_LOGOS[key] ?? ''
}

function sourceCard(source: { key: string; name: string; url: string; thumbnail?: string }): string {
  const logo = source.thumbnail ?? logoFor(source.key)
  return `<a class="source-card" href="${source.url}" data-name="${source.name}" aria-label="打开${source.name}">
        <span class="source-logo"><img src="${logo}" alt="" /></span>
      </a>`
}

const START_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>InsPin</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    background: #FFFFFF; color: #171A26;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "PingFang-SC", "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .home-stack {
    display: flex; align-items: center; flex-direction: column; gap: 16px;
    margin-top: -48px;
  }
  .home-pin { width: 100px; height: 100px; }
  .home-title { margin: 0; color: #171A26; font-size: 32px; font-weight: 500; letter-spacing: -0.04em; }
  .home-copy { margin: 0; color: #3D414D; font-size: 20px; white-space: nowrap; }
  /* 进入站点编辑后只保留编辑区，顶部标识和标题不再占地方。 */
  .home-stack[data-editing='true'] { margin-top: 0; }
  .home-stack[data-editing='true'] .home-pin,
  .home-stack[data-editing='true'] .home-title,
  .home-stack[data-editing='true'] .home-copy { display: none; }
  .home-stack[data-editing='true'] .source-wrap { margin-top: 0; }
  .source-wrap { position: relative; margin-top: 36px; }
  /* 设计稿 42:2777：78 方块、间距 21；侧栏放不下时折成 3 列（最多 12 个 → 4 排）。
     用 flex 而不是 grid，数量不满一行时最后一行也能居中。 */
  .source-list {
    display: flex; flex-wrap: wrap; justify-content: center; gap: 21px;
    max-width: 605px; padding: 16px;
    background: transparent;
  }
  .source-list[hidden], .source-edit[hidden] { display: none; }
  .source-card {
    position: relative; display: grid; width: 78px; height: 78px;
    place-items: center; padding: 0; border: 0; border-radius: 20px;
    background: rgba(0, 0, 0, .12);
    box-shadow: inset -2px 2px 4px rgba(0, 0, 0, .03);
    text-decoration: none; cursor: pointer;
    transition: transform .16s ease, box-shadow .16s ease;
  }
  .source-logo {
    display: grid; width: 53px; height: 53px; place-items: center;
    overflow: hidden; border-radius: 16px;
  }
  .source-logo img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .source-card:hover, .source-card:focus-visible {
    z-index: 3; transform: translateY(-2px); outline: none;
    box-shadow: inset -2px 2px 4px rgba(0, 0, 0, .03), 0 4px 10px rgba(23, 26, 38, .10);
  }
  .source-card:active { transform: scale(.96); }
  /* 名称只在悬停 / 键盘聚焦时出现，视觉上保持设计稿的纯图标。 */
  .source-card::after {
    content: attr(data-name);
    position: absolute; z-index: 2; left: 50%; bottom: calc(100% + 8px);
    width: max-content;
    padding: 6px 8px; border-radius: 8px; color: #FFFFFF; background: #3D414D;
    font-size: 12px; line-height: 1; text-align: center; white-space: nowrap; pointer-events: none;
    opacity: 0; transform: translate(-50%, 4px);
    transition: opacity .12s ease, transform .12s ease;
  }
  .source-card:hover::after, .source-card:focus-visible::after {
    opacity: 1; transform: translate(-50%, 0);
  }
  .source-card:focus-visible { outline: 2px solid #3D414D; outline-offset: 2px; }
  @media (max-width: 660px) {
    .source-list { max-width: 308px; }
  }
  .source-list[data-reordering='true'] { cursor: grabbing; user-select: none; }
  .source-card--dragging { opacity: .48; transform: scale(.94); cursor: grabbing; }
  /* 右键菜单统一复用设计规范的通用菜单尺寸：172 宽 / pad 8 / 项高 36 / 14px。 */
  .source-context {
    position: fixed; z-index: 5; display: flex; flex-direction: column; width: 172px;
    padding: 8px; border: 0.5px solid rgba(0, 0, 0, .08);
    border-radius: 12px; background: #FFFFFF; box-shadow: 0 0 4px rgba(0, 0, 0, .05);
  }
  .source-context[hidden] { display: none; }
  .source-context button {
    display: flex; align-items: center; width: 100%; min-height: 36px; padding: 8px; border: 0; border-radius: 10px;
    color: #3D414D; background: transparent; font: inherit; font-size: 14px; text-align: left; cursor: pointer;
  }
  .source-context button:hover, .source-context button:focus-visible { background: #F1F1F1; outline: none; }
  .source-manager {
    display: grid; width: min(771px, calc(100vw - 48px)); gap: 24px; padding: 0;
  }
  .source-manager[hidden] { display: none; }
  .source-manager__sites { display: grid; gap: 16px; }
  .source-manager__row {
    display: flex; align-items: center; gap: 12px; min-width: 0; padding: 8px;
    border-radius: 12px; background: transparent;
  }
  .source-manager__row[data-dragging='true'], .source-manager__row[data-drop-target='true'] { background: #F9F9F9; }
  .source-manager__drag {
    display: grid; flex: 0 0 24px; width: 24px; height: 24px; padding: 0 !important;
    place-items: center; border-radius: 6px !important; background: transparent !important; cursor: grab !important;
  }
  .source-manager__drag:active { cursor: grabbing !important; }
  .source-manager__drag img { display: block; width: 24px; height: 24px; }
  .source-manager__thumbnail {
    display: grid; flex: 0 0 40px; width: 40px; height: 40px; padding: 0 !important;
    place-items: center; overflow: hidden; border: 1px solid rgba(0, 0, 0, .07) !important;
    border-radius: 12px !important; background: #F5F4F7; cursor: pointer !important;
  }
  .source-manager__thumbnail:hover, .source-manager__thumbnail:focus-visible { filter: brightness(.96); }
  .source-manager__thumbnail img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .source-manager__thumbnail span { color: #C2C4CC; font-size: 14px; }
  .source-manager input {
    min-width: 0; height: 40px; box-sizing: border-box; padding: 0 10px;
    border: 1px solid rgba(0, 0, 0, .07); border-radius: 12px; color: #3D414D; background: #FFFFFF;
    font: inherit; font-size: 14px;
  }
  .source-manager input::placeholder { color: #C2C4CC; }
  .source-manager__name { flex: 0 0 100px; width: 100px; text-align: center; }
  .source-manager__url { flex: 1 1 355px; width: 355px; }
  .source-manager button {
    height: 40px; padding: 0 10px; border: 0; border-radius: 12px;
    color: #171A26; background: #F1F1F1; font: inherit; font-size: 14px; cursor: pointer;
  }
  .source-manager button:hover, .source-manager button:focus-visible { color: #3D414D; background: #E9E9EB; outline: none; }
  .source-manager button:active { transform: scale(.97); }
  .source-manager__row-actions { display: flex; flex: 0 0 auto; gap: 12px; margin-left: 12px; }
  .source-manager__row-actions button, .source-manager__actions button { width: 80px; }
  .source-manager__remove { color: #D92D20 !important; background: #FFF1F0 !important; }
  .source-manager__remove:hover, .source-manager__remove:focus-visible { background: #FFE0E7 !important; }
  .source-manager__row-actions[data-disabled='true'] { opacity: .5; }
  .source-manager__row-actions button:disabled { cursor: default; }
  .source-manager__row-actions button:disabled:hover { color: #171A26; background: #F1F1F1; }
  .source-manager__actions { display: flex; justify-content: space-between; gap: 16px; }
  .source-manager__add { color: #3D414D !important; background: #F5F5F5 !important; }
  .source-manager__done { color: #FFFFFF !important; background: #3D414D !important; }
  .source-manager__done:hover, .source-manager__done:focus-visible { color: #FFFFFF !important; background: #252936 !important; }
  @media (max-width: 760px) {
    .source-manager__row { flex-wrap: wrap; }
    .source-manager__url { flex-basis: calc(100% - 188px); }
    .source-manager__row-actions { margin-left: 36px; }
  }
  .source-notice {
    position: fixed; z-index: 8; top: 24px; left: 50%; margin: 0; padding: 7px 10px;
    border-radius: 8px; color: #FFFFFF; background: #3D414D; box-shadow: 0 4px 12px rgba(23, 26, 38, .16);
    font-size: 12px; transform: translateX(-50%);
  }
  .source-notice[hidden] { display: none; }
</style>
</head>
<body>
  <div class="home-stack">
    <img class="home-pin" src="${START_PAGE_MARK}" alt="" aria-hidden="true" />
    <h1 class="home-title">灵感钉</h1>
    <p class="home-copy">打开任意站点 捕获你的灵感</p>
    <div class="source-wrap">
      <div class="source-list" id="source-list" aria-label="为玩家推荐的网站">
        ${SOURCES.map(sourceCard).join('\n        ')}
      </div>
      <section class="source-manager" id="source-manager" aria-label="编辑推荐网站" hidden></section>
      <div class="source-context" id="source-context" role="menu" hidden>
        <button id="source-context-edit" type="button" role="menuitem">修改或删除站点</button>
      </div>
      <p class="source-notice" id="source-notice" role="status" hidden></p>
    </div>
  </div>
  <script>
    const SOURCE_KEY = 'inspin.start-page.sources.v1';
    const DEFAULT_SOURCES = ${JSON.stringify(SOURCES)};
    const SERVER_SOURCES = __INSPIN_STORED_SOURCES__;
    const START_PAGE_TOKEN = __INSPIN_START_TOKEN__;
    const homeStack = document.querySelector('.home-stack');
    const sourceList = document.getElementById('source-list');
    const manager = document.getElementById('source-manager');
    const contextMenu = document.getElementById('source-context');
    const contextEdit = document.getElementById('source-context-edit');
    const notice = document.getElementById('source-notice');
    let sources = normalizeSources(loadSources());
    // 第一次运行（或旧版本升上来）：把当前列表写到主进程，下一次启动才丢不了。
    if (!validSources(SERVER_SOURCES)) saveSources();
    let noticeTimer = null;
    let pressTimer = null;
    let draggingCard = null;
    let draggingManagerRow = null;
    let draftSite = null;
    let preventNextClick = false;
    const REORDER_ICON = 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJub25lIiBoZWlnaHQ9IjI0IiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIj48cGF0aCBkPSJNMS41IDBDMC42NzUwMDAwMSAwIDAgMC42NzUwMDAwMSAwIDEuNUMwIDIuMzI1IDAuNjc1MDAwMDEgMyAxLjUgM0MyLjMyNSAzIDMgMi4zMjUgMyAxLjVDMyAwLjY3NTAwMDAxIDIuMzI1IDAgMS41IDBaTTEuNSAxNUMwLjY3NTAwMDAxIDE1IDAgMTUuNjc1IDAgMTYuNUMwIDE3LjMyNTAwMSAwLjY3NTAwMDEgMTggMS41IDE4QzIuMzI1IDE4IDMgMTcuMzI1MDAxIDMgMTYuNUMzIDE1LjY3NSAyLjMyNSAxNSAxLjUgMTVaTTEuNSA3LjVDMC42NzUwMDAwMSA3LjUgMCA4LjE3NTAwMDIgMCA5QzAgOS44MjQ5OTk4IDAuNjc1MDAwMDEgMTAuNSAxLjUgMTAuNUMyLjMyNSAxMC41IDMgOS44MjQ5OTggMyA5QzMgOC4xNzUwMDAyIDIuMzI1IDcuNSAxLjUgNy41WiIgZmlsbD0iIzgyODc5NCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNywgMykiLz48cGF0aCBkPSJNMS41IDBDMC42NzUwMDAwMSAwIDAgMC42NzUwMDAwMSAwIDEuNUMwIDIuMzI1IDAuNjc1MDAwMDEgMyAxLjUgM0MyLjMyNSAzIDMgMi4zMjUgMyAxLjVDMyAwLjY3NTAwMDAxIDIuMzI1IDAgMS41IDBaTTEuNSAxNUMwLjY3NTAwMDAxIDE1IDAgMTUuNjc1IDAgMTYuNUMwIDE3LjMyNTAwMSAwLjY3NTAwMDEgMTggMS41IDE4QzIuMzI1IDE4IDMgMTcuMzI1MDAxIDMgMTYuNUMzIDE1LjY3NSAyLjMyNSAxNSAxLjUgMTVaTTEuNSA3LjVDMC42NzUwMDAwMSA3LjUgMCA4LjE3NTAwMDIgMCA5QzAgOS44MjQ5OTk4IDAuNjc1MDAwMDEgMTAuNSAxLjUgMTAuNUMyLjMyNSAxMC41IDMgOS44MjQ5OTggMyA5QzMgOC4xNzUwMDAyIDIuMzI1IDcuNSAxLjUgNy41WiIgZmlsbD0iIzgyODc5NCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTQsIDMpIi8+PC9zdmc+';
    const MAX_SITE_COUNT = ${MAX_START_SOURCES};
    const TINT_FALLBACK = 'rgba(0, 0, 0, .12)';
    const tintCache = new Map();

    /** 从 logo 里取面积最大的颜色，按 12% 铺成站点块底色。 */
    function extractTint(image) {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return TINT_FALLBACK;
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        const buckets = new Map();
        for (let index = 0; index < pixels.length; index += 4) {
          const alpha = pixels[index + 3];
          if (alpha < 128) continue;
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          // 白底 / 白色描边不算品牌色，否则整块会被染成看不出来的白
          if (red > 245 && green > 245 && blue > 245) continue;
          const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
          const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
          bucket.count += 1;
          bucket.r += red;
          bucket.g += green;
          bucket.b += blue;
          buckets.set(key, bucket);
        }
        let best = null;
        for (const bucket of buckets.values()) {
          if (!best || bucket.count > best.count) best = bucket;
        }
        if (!best) return TINT_FALLBACK;
        const r = Math.round(best.r / best.count);
        const g = Math.round(best.g / best.count);
        const b = Math.round(best.b / best.count);
        return 'rgba(' + r + ', ' + g + ', ' + b + ', .12)';
      } catch (_) {
        return TINT_FALLBACK;
      }
    }

    /** 给卡片或编辑页缩略图铺上主色底；同一张图只算一次。 */
    function applyTint(element, imageUrl, image) {
      const cached = tintCache.get(imageUrl);
      if (cached) {
        element.style.background = cached;
        return;
      }
      const paint = () => {
        const tint = extractTint(image);
        tintCache.set(imageUrl, tint);
        element.style.background = tint;
      };
      if (image.complete && image.naturalWidth > 0) paint();
      else image.addEventListener('load', paint, { once: true });
      image.addEventListener('error', () => tintCache.set(imageUrl, TINT_FALLBACK), { once: true });
    }

    function hostnameOf(url) {
      try {
        return new URL(url).hostname.replace(/^www\\./, '');
      } catch (_) {
        return '';
      }
    }

    async function fetchSiteMeta(url) {
      try {
        const response = await fetch('/site-meta', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-InsPin-Start-Token': START_PAGE_TOKEN
          },
          body: JSON.stringify({ url })
        });
        if (!response.ok) return { name: '', icon: null };
        const data = await response.json();
        return {
          name: typeof data.name === 'string' ? data.name : '',
          icon: typeof data.icon === 'string' ? data.icon : null
        };
      } catch (_) {
        return { name: '', icon: null };
      }
    }

    function sourceId(source, index) {
      return source.id || source.key || 'site-' + index;
    }

    // 站点地址必须是绝对地址：只写 www.baidu.com 时补 https://，
    // 否则会变成当前起始页（127.0.0.1）下的相对路径。
    function normalizeSourceUrl(input) {
      const text = String(input || '').trim();
      if (!text) return '';
      if (/^https?:\\/\\//i.test(text)) return text;
      if (/^[a-z][a-z0-9+.-]*:\\/\\//i.test(text)) return '';
      if (/^(javascript|data|file|blob|about|chrome|devtools):/i.test(text)) return '';
      return 'https://' + text.replace(/^\\/+/, '');
    }

    function normalizeSources(list) {
      return list.map((source, index) => {
        const url = normalizeSourceUrl(source.url);
        return { ...source, id: sourceId(source, index), url: url || source.url };
      });
    }

    function validSources(list) {
      return Array.isArray(list) && list.every((item) => item && typeof item.name === 'string' && typeof item.url === 'string');
    }

    function loadSources() {
      // 主进程存的那份是权威的：起始页端口每次启动都变，localStorage 留不住。
      if (validSources(SERVER_SOURCES)) return SERVER_SOURCES;
      try {
        const stored = JSON.parse(localStorage.getItem(SOURCE_KEY) || 'null');
        if (validSources(stored)) return stored;
      } catch (_) {}
      return DEFAULT_SOURCES;
    }

    function saveSources() {
      try { localStorage.setItem(SOURCE_KEY, JSON.stringify(sources)); } catch (_) {}
      // 同步给主进程落盘；失败时至少本次会话的 localStorage 还在。
      fetch('/sources', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-InsPin-Start-Token': START_PAGE_TOKEN
        },
        body: JSON.stringify(sources)
      }).catch(() => {});
    }

    function showNotice(message) {
      notice.textContent = message;
      notice.hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { notice.hidden = true; }, 1600);
    }

    function sourceImage(source) {
      if (source.thumbnail) return source.thumbnail;
      return source.key ? '/source-logo/' + encodeURIComponent(source.key) : '';
    }

    function makeCard(source) {
      const card = document.createElement('a');
      card.className = 'source-card';
      card.dataset.sourceId = source.id;
      // 名称只放在悬停提示和无障碍标签里，视觉上保持设计稿的纯图标
      card.dataset.name = source.name;
      card.setAttribute('aria-label', '打开' + source.name);
      const href = normalizeSourceUrl(source.url);
      if (href) {
        card.href = href;
      } else {
        card.href = '#';
        card.addEventListener('click', (event) => {
          event.preventDefault();
          showNotice('网站地址格式不正确');
        });
      }
      const logo = document.createElement('span');
      logo.className = 'source-logo';
      const imageUrl = sourceImage(source);
      if (imageUrl) {
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = '';
        logo.append(image);
        applyTint(card, imageUrl, image);
      } else {
        logo.textContent = (source.name || '?').slice(0, 1);
        logo.style.background = '#F5F4F7';
        logo.style.color = '#6B7078';
        logo.style.fontSize = '28px';
      }
      card.append(logo);
      enableLongPressReorder(card);
      return card;
    }

    function renderCards() {
      sourceList.replaceChildren(...sources.map(makeCard));
    }

    function finishReorder() {
      clearTimeout(pressTimer);
      if (!draggingCard) return;
      const orderedIds = [...sourceList.querySelectorAll('.source-card')].map((card) => card.dataset.sourceId);
      sources = orderedIds.map((id) => sources.find((source) => source.id === id)).filter(Boolean);
      saveSources();
      draggingCard.classList.remove('source-card--dragging');
      delete sourceList.dataset.reordering;
      draggingCard = null;
      preventNextClick = true;
      setTimeout(() => { preventNextClick = false; }, 0);
      showNotice('网站顺序已更新');
    }

    function enableLongPressReorder(card) {
      card.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          draggingCard = card;
          sourceList.dataset.reordering = 'true';
          card.classList.add('source-card--dragging');
        }, 320);
      });
      card.addEventListener('pointerleave', () => {
        if (!draggingCard) clearTimeout(pressTimer);
      });
      card.addEventListener('pointercancel', finishReorder);
      card.addEventListener('click', (event) => {
        if (!preventNextClick) return;
        event.preventDefault();
        event.stopPropagation();
      });
    }

    document.addEventListener('pointermove', (event) => {
      if (!draggingCard) return;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.source-card');
      if (!target || target === draggingCard || !sourceList.contains(target)) return;
      const rect = target.getBoundingClientRect();
      sourceList.insertBefore(draggingCard, event.clientX < rect.left + rect.width / 2 ? target : target.nextSibling);
    });
    document.addEventListener('pointerup', finishReorder);

    function appendThumbnailButton(row, source, updateSource) {
      const thumbnail = document.createElement('button');
      thumbnail.type = 'button';
      thumbnail.className = 'source-manager__thumbnail';
      thumbnail.title = '点击替换缩略图';
      thumbnail.setAttribute('aria-label', '点击替换缩略图');
      const previewUrl = sourceImage(source);
      if (previewUrl) {
        const preview = document.createElement('img');
        preview.src = previewUrl;
        preview.alt = '';
        thumbnail.append(preview);
        applyTint(thumbnail, previewUrl, preview);
      } else {
        const fallback = document.createElement('span');
        fallback.textContent = source.name ? source.name.slice(0, 1) : '新';
        thumbnail.append(fallback);
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.hidden = true;
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          updateSource({ ...source, thumbnail: String(reader.result || '') });
          showNotice('缩略图已更新');
        });
        reader.readAsDataURL(file);
      });
      thumbnail.addEventListener('click', () => input.click());
      row.append(thumbnail, input);
    }

    function makeManagerRow(source, index, isDraft) {
      const row = document.createElement('form');
      row.className = 'source-manager__row';
      row.dataset.sourceId = source.id;
      const drag = document.createElement('button');
      drag.type = 'button';
      drag.className = 'source-manager__drag';
      drag.title = '拖拽调整顺序';
      drag.setAttribute('aria-label', '拖拽调整顺序');
      const dragIcon = document.createElement('img');
      dragIcon.src = REORDER_ICON;
      dragIcon.alt = '';
      drag.append(dragIcon);
      if (!isDraft) enableManagerReorder(drag, row);
      else drag.disabled = true;
      row.append(drag);

      const updateSource = (nextSource) => {
        if (isDraft) {
          draftSite = nextSource;
          renderManager();
          return;
        }
        sources[index] = nextSource;
        saveSources();
        renderManager();
      };
      appendThumbnailButton(row, source, updateSource);

      const name = document.createElement('input');
      name.className = 'source-manager__name';
      name.value = source.name;
      name.placeholder = '留空自动获取';
      name.setAttribute('aria-label', '网站名称');
      const url = document.createElement('input');
      url.className = 'source-manager__url';
      url.value = source.url;
      url.placeholder = '输入 URL 链接';
      url.setAttribute('aria-label', '网站地址');
      const actions = document.createElement('div');
      actions.className = 'source-manager__row-actions';
      const save = document.createElement('button');
      save.type = 'submit';
      save.textContent = '保存';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'source-manager__remove';
      remove.textContent = '删除';
      let nameEdited = false;
      let busy = false;
      // 新增站点只要求地址：名称留空时由站点页面自动抓
      const updateDraftButtons = () => {
        if (busy) return;
        save.disabled = isDraft && !url.value.trim();
        actions.dataset.disabled = 'false';
      };
      const setBusy = (next) => {
        busy = next;
        save.disabled = next;
        remove.disabled = next;
        name.disabled = next;
        url.disabled = next;
        save.textContent = next ? '获取中…' : '保存';
        actions.dataset.disabled = 'false';
      };
      name.addEventListener('input', () => {
        nameEdited = true;
        updateDraftButtons();
      });
      url.addEventListener('input', updateDraftButtons);
      if (isDraft) updateDraftButtons();
      remove.addEventListener('click', () => {
        if (isDraft) {
          draftSite = null;
          renderManager();
          return;
        }
        sources.splice(index, 1);
        saveSources();
        renderManager();
        showNotice('网站已删除');
      });
      row.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy) return;
        const nextUrl = normalizeSourceUrl(url.value);
        if (!nextUrl) {
          showNotice('请填写正确的网站地址');
          return;
        }
        if (isDraft && sources.length >= MAX_SITE_COUNT) {
          showNotice('最多收藏 ' + MAX_SITE_COUNT + ' 个站点');
          return;
        }

        let nextName = name.value.trim();
        let nextThumbnail = source.thumbnail || '';
        const urlChanged = nextUrl !== normalizeSourceUrl(source.url);
        const needName = !nextName || (urlChanged && !nameEdited);
        const needIcon = !nextThumbnail;
        if (needName || needIcon) {
          setBusy(true);
          showNotice('正在获取站点信息…');
          const meta = await fetchSiteMeta(nextUrl);
          if (needName) nextName = meta.name.trim().slice(0, 80);
          if (needIcon && meta.icon) nextThumbnail = meta.icon;
          setBusy(false);
        }
        if (!nextName) nextName = hostnameOf(nextUrl) || nextUrl;

        const nextSource = { ...source, name: nextName, url: nextUrl };
        if (nextThumbnail) nextSource.thumbnail = nextThumbnail;
        if (isDraft) {
          sources.push(nextSource);
          draftSite = null;
        } else {
          sources[index] = nextSource;
        }
        saveSources();
        renderManager();
        showNotice(isDraft ? '网站已新增' : '网站已保存');
      });
      actions.append(save, remove);
      row.append(name, url, actions);
      return row;
    }

    function renderManager() {
      manager.replaceChildren();
      const sites = document.createElement('div');
      sites.className = 'source-manager__sites';
      sources.forEach((source, index) => sites.append(makeManagerRow(source, index, false)));
      if (draftSite) sites.append(makeManagerRow(draftSite, sources.length, true));
      manager.append(sites);
      const actions = document.createElement('div');
      actions.className = 'source-manager__actions';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'source-manager__add';
      add.textContent = '添加站点';
      const atLimit = sources.length >= MAX_SITE_COUNT;
      add.disabled = Boolean(draftSite) || atLimit;
      if (atLimit) add.title = '最多收藏 ' + MAX_SITE_COUNT + ' 个站点';
      add.addEventListener('click', () => {
        if (sources.length >= MAX_SITE_COUNT) {
          showNotice('最多收藏 ' + MAX_SITE_COUNT + ' 个站点');
          return;
        }
        draftSite = { id: 'site-' + Date.now(), name: '', url: '', key: '', thumbnail: '' };
        renderManager();
      });
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'source-manager__done';
      done.textContent = '完成';
      done.addEventListener('click', () => {
        manager.hidden = true;
        sourceList.hidden = false;
        delete homeStack.dataset.editing;
        renderCards();
        showNotice('网站设置已更新');
      });
      actions.append(add, done);
      manager.append(actions);
    }

    function finishManagerReorder() {
      if (!draggingManagerRow) return;
      const sites = manager.querySelector('.source-manager__sites');
      const orderedIds = [...sites.querySelectorAll('.source-manager__row[data-source-id]')]
        .map((row) => row.dataset.sourceId)
        .filter((id) => id !== draftSite?.id);
      sources = orderedIds.map((id) => sources.find((source) => source.id === id)).filter(Boolean);
      saveSources();
      draggingManagerRow.removeAttribute('data-dragging');
      draggingManagerRow = null;
      showNotice('网站顺序已更新');
    }

    function enableManagerReorder(handle, row) {
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        draggingManagerRow = row;
        row.dataset.dragging = 'true';
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointerup', finishManagerReorder);
      handle.addEventListener('pointercancel', finishManagerReorder);
    }

    document.addEventListener('pointermove', (event) => {
      if (!draggingManagerRow) return;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.source-manager__row');
      const sites = manager.querySelector('.source-manager__sites');
      if (!target || target === draggingManagerRow || !sites?.contains(target) || target.dataset.sourceId === draftSite?.id) return;
      const rect = target.getBoundingClientRect();
      sites.insertBefore(draggingManagerRow, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
    });
    document.addEventListener('pointerup', finishManagerReorder);
    document.addEventListener('pointercancel', finishManagerReorder);

    function openEditor() {
      contextMenu.hidden = true;
      sourceList.hidden = true;
      manager.hidden = false;
      homeStack.dataset.editing = 'true';
      renderManager();
    }

    sourceList.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      contextMenu.style.left = event.clientX + 'px';
      contextMenu.style.top = event.clientY + 'px';
      contextMenu.hidden = false;
    });
    contextEdit.addEventListener('click', openEditor);
    document.addEventListener('pointerdown', (event) => {
      if (!contextMenu.contains(event.target)) contextMenu.hidden = true;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') contextMenu.hidden = true;
    });
    renderCards();
  </script>
</body>
</html>
`

export interface StartPageServer {
  url: string
  close: () => void
  /** 收藏一个网页到推荐站点；同一网址会覆盖旧信息而不是重复添加。 */
  addSource: (favorite: { url: string; title?: string; favicon?: string | null }) => Promise<boolean>
  /** 从推荐站点里移除一个网址（取消收藏）。 */
  removeSource: (url: string) => boolean
  /** 当前推荐站点的网址列表，界面用来判断收藏按钮是否已收藏。 */
  listSourceUrls: () => string[]
}

export interface StartPageServerOptions {
  /**
   * 自定义来源列表的落盘位置。
   *
   * 起始页每次启动都监听随机端口，而 localStorage 按 origin 隔离——端口一变，
   * 之前改过的网站就"回到初始态"了。把这份用户定制存成文件、由主进程注入页面，
   * 才能跨启动保留。
   */
  sourcesFile?: string
  /** 只给本地 HTTP 测试服务器使用；正式应用永远不应开启。 */
  allowPrivateSiteMetaForTests?: boolean
}

const MAX_SOURCES_BODY = 10 * 1024 * 1024

function readStoredSources(file: string | undefined): unknown[] | null {
  if (!file) return null
  try {
    return normalizeStoredSources(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  } catch {
    return null
  }
}

/**
 * 自定义站点地址的补全规则。
 *
 * 用户常只写 `www.baidu.com`。起始页本身跑在 `http://127.0.0.1:<端口>/`，
 * 直接塞进 `<a href>` 会被当成相对地址，变成 `http://127.0.0.1:<端口>/www.baidu.com`。
 * 所以统一补成绝对地址；只接受 http(s)，其他协议（file:、javascript: 等）直接拒绝。
 */
export function normalizeSourceUrl(input: string): string {
  const text = input.trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text
  // 带 `://` 的非 http(s) 协议（ftp:、file: 等）不接受
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return ''
  // 不带斜杠的脚本/本地协议（javascript:、data: 等）也不接受
  if (/^(javascript|data|file|blob|about|chrome|devtools):/i.test(text)) return ''
  return `https://${text.replace(/^\/+/, '')}`
}

/** 只接受页面真正用得到的字段，挡掉异常体积与奇怪类型。 */
function normalizeStoredSources(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw) || raw.length > 100) return null
  const result: Record<string, unknown>[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const source = item as Record<string, unknown>
    if (typeof source.name !== 'string' || typeof source.url !== 'string') return null
    if (source.name.length > 80 || source.url.length > 2048) return null
    const url = normalizeSourceUrl(source.url)
    if (!url) return null
    const next: Record<string, unknown> = { name: source.name, url }
    for (const key of ['id', 'key', 'thumbnail'] as const) {
      if (typeof source[key] === 'string' && (source[key] as string).length <= MAX_SOURCES_BODY) {
        next[key] = source[key]
      }
    }
    result.push(next)
  }
  return result
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * 旧默认站点（花瓣/站酷/小红书那版，以及没有 X 的五站点版）换成设计稿的六站点。
 * 用户自己加的站点继续保留；用 X 是否在列表里判断是否已经迁移过。
 */
function migrateStoredSources(list: unknown[] | null): unknown[] | null {
  if (!list || list.length === 0) return list
  const urls = list.map((item) => normalizeSourceUrl(String((item as Record<string, unknown>).url ?? '')))
  if (urls.some((url) => sourceHost(url) === 'x.com')) return list
  const hasReplacedDefaults = urls.some((url) => REPLACED_DEFAULT_HOSTS.has(sourceHost(url)))
  if (!hasReplacedDefaults) return list

  const seen = new Set(SOURCES.map((source) => normalizeSourceUrl(source.url)))
  const custom = list.filter((item) => {
    const url = normalizeSourceUrl(String((item as Record<string, unknown>).url ?? ''))
    if (!url || seen.has(url) || REPLACED_DEFAULT_HOSTS.has(sourceHost(url))) return false
    seen.add(url)
    return true
  })
  return [...SOURCES.map((source) => ({ ...source, id: source.key })), ...custom].slice(0, MAX_SOURCES)
}

const SITE_META_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const SITE_META_HTML_LIMIT = 512 * 1024
const SITE_META_ICON_LIMIT = 512 * 1024
const SITE_META_MAX_REDIRECTS = 5

const BLOCKED_NETWORKS = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  BLOCKED_NETWORKS.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32]
] as const) {
  BLOCKED_NETWORKS.addSubnet(network, prefix, 'ipv6')
}

function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped) return BLOCKED_NETWORKS.check(mapped, 'ipv4')
  const family = isIP(address)
  return family === 4
    ? BLOCKED_NETWORKS.check(address, 'ipv4')
    : family === 6
      ? BLOCKED_NETWORKS.check(address, 'ipv6')
      : true
}

async function assertPublicHttpTarget(url: URL, allowPrivate: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  if (allowPrivate) return
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new Error('private hostname')
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('private address')
  }
}

async function fetchPublicResource(
  rawUrl: string,
  init: RequestInit,
  allowPrivate: boolean
): Promise<Response> {
  let current = new URL(rawUrl)
  for (let redirects = 0; redirects <= SITE_META_MAX_REDIRECTS; redirects += 1) {
    await assertPublicHttpTarget(current, allowPrivate)
    const response = await fetch(current, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    await response.body?.cancel().catch(() => {})
    current = new URL(location, current)
  }
  throw new Error('too many redirects')
}

/** 网页标题里的实体会原样带出来，这里只解最常见的几种。 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    if (key === 'nbsp') return ' '
    if (key.startsWith('#x') || key.startsWith('#')) {
      const code = Number.parseInt(key.startsWith('#x') ? key.slice(2) : key.slice(1), key.startsWith('#x') ? 16 : 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return whole
  })
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([a-zA-Z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(tag))) {
    attrs[match[1]!.toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? ''
  }
  return attrs
}

/** 优先 apple-touch-icon，其次 sizes 最大的 icon，最后退回 /favicon.ico。 */
function pickIconUrl(html: string, pageUrl: string): string | null {
  let best: { url: string; score: number } | null = null
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0])
    const rel = (attrs.rel ?? '').toLowerCase()
    if (!/(^|\s)(apple-touch-icon|apple-touch-icon-precomposed|icon|shortcut icon)(\s|$)/.test(rel)) continue
    if (!attrs.href) continue
    let resolved: string
    try {
      resolved = new URL(attrs.href, pageUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:/i.test(resolved)) continue
    let score = 1
    if (rel.includes('apple-touch-icon')) score += 100
    const size = /(\d+)x(\d+)/i.exec(attrs.sizes ?? '')
    if (size) score += Math.min(80, Number(size[1]) / 4)
    if (!best || score > best.score) best = { url: resolved, score }
  }
  if (best) return best.url
  try {
    return new URL('/favicon.ico', pageUrl).toString()
  } catch {
    return null
  }
}

async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  while (size < cap) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const take = value.subarray(0, Math.max(0, cap - size))
    chunks.push(Buffer.from(take))
    size += take.length
    if (size >= cap) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return Buffer.concat(chunks)
}

function imageMime(bytes: Buffer, contentType: string): string | null {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type.startsWith('image/')) return type
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon'
  return sniffImageFormat(bytes)?.mime ?? null
}

async function fetchIconDataUri(
  iconUrl: string,
  referer: string,
  allowPrivate: boolean
): Promise<string | null> {
  try {
    const response = await fetchPublicResource(iconUrl, {
      signal: AbortSignal.timeout(6000),
      referrer: referer,
      referrerPolicy: 'unsafe-url',
      headers: { 'user-agent': SITE_META_USER_AGENT }
    }, allowPrivate)
    if (!response.ok) return null
    const bytes = await readCapped(response, SITE_META_ICON_LIMIT)
    const mime = bytes.length > 0 ? imageMime(bytes, response.headers.get('content-type') ?? '') : null
    if (!mime) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** 打开用户填的站点，抓 <title> 和尽可能大的站点图标；失败就返回空，让界面自己兜底。 */
async function fetchSiteMeta(
  rawUrl: string,
  allowPrivate = false
): Promise<{ name: string; icon: string | null }> {
  const url = normalizeSourceUrl(rawUrl)
  if (!url) return { name: '', icon: null }
  try {
    const response = await fetchPublicResource(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': SITE_META_USER_AGENT, accept: 'text/html,application/xhtml+xml' }
    }, allowPrivate)
    if (!response.ok) return { name: '', icon: null }
    const html = (await readCapped(response, SITE_META_HTML_LIMIT)).toString('utf8')
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
    const name = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : ''
    const iconUrl = pickIconUrl(html, response.url || url)
    const icon = iconUrl ? await fetchIconDataUri(iconUrl, response.url || url, allowPrivate) : null
    return { name: name.slice(0, 80), icon }
  } catch {
    return { name: '', icon: null }
  }
}

/** 注入 HTML 的 JSON 不能带 `<`，否则字符串里的 `</script>` 会提前结束脚本。 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c')
}

function writeStoredSources(file: string, sources: unknown[]): void {
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(sources), 'utf8')
  renameSync(temp, file)
}

export function startStartPageServer(options: StartPageServerOptions = {}): Promise<StartPageServer> {
  return new Promise((resolve, reject) => {
    const startPageToken = randomBytes(32).toString('hex')
    let storedSources = readStoredSources(options.sourcesFile)
    // 只在升级后跑一次：用户之后主动删掉 X 也不会被重新加回来
    const migrationMarker = options.sourcesFile ? `${options.sourcesFile}.v2` : null
    const alreadyMigrated = migrationMarker ? existsSync(migrationMarker) : false
    if (!alreadyMigrated) {
      const migrated = migrateStoredSources(storedSources)
      if (migrated !== storedSources) {
        storedSources = normalizeStoredSources(migrated)
        if (storedSources && options.sourcesFile) writeStoredSources(options.sourcesFile, storedSources)
      }
      if (migrationMarker) writeFileSync(migrationMarker, '2', 'utf8')
    }
    const server = createServer((req, res) => {
      const method = req.method ?? 'GET'
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

      if (pathname === '/sources') {
        if (method === 'GET' || method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          })
          res.end(method === 'HEAD' ? undefined : JSON.stringify(storedSources))
          return
        }
        if (method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        if (req.headers['x-inspin-start-token'] !== startPageToken) {
          res.writeHead(403).end()
          return
        }
        let size = 0
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_SOURCES_BODY) {
            res.writeHead(413).end()
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          if (res.writableEnded) return
          try {
            const parsed = normalizeStoredSources(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            if (!parsed || parsed.length > MAX_SOURCES) {
              res.writeHead(400).end()
              return
            }
            storedSources = parsed
            if (options.sourcesFile) writeStoredSources(options.sourcesFile, parsed)
            res.writeHead(204).end()
          } catch {
            res.writeHead(400).end()
          }
        })
        return
      }

      if (pathname === '/site-meta') {
        if (method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        if (req.headers['x-inspin-start-token'] !== startPageToken) {
          res.writeHead(403).end()
          return
        }
        let size = 0
        const chunks: Buffer[] = []
        const tooLarge = (): void => {
          res.writeHead(413).end()
          req.destroy()
        }
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 8 * 1024) {
            tooLarge()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          if (res.writableEnded) return
          let rawUrl = ''
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: unknown }
            rawUrl = typeof parsed.url === 'string' ? parsed.url : ''
          } catch {
            res.writeHead(400).end()
            return
          }
          void fetchSiteMeta(rawUrl, options.allowPrivateSiteMetaForTests === true)
            .then((meta) => {
              if (res.writableEnded) return
              res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
              })
              res.end(JSON.stringify(meta))
            })
            .catch(() => {
              if (!res.writableEnded) res.writeHead(500).end()
            })
        })
        return
      }

      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405).end()
        return
      }
      if (pathname.startsWith('/source-logo/')) {
        const key = decodeURIComponent(pathname.slice('/source-logo/'.length))
        const dataUrl = DESIGN_SOURCE_LOGOS[key] ?? RELAY_SOURCE_LOGOS[key] ?? SOURCE_LOGOS[key]
        const matched = /^data:([^;]+);base64,(.+)$/.exec(dataUrl ?? '')
        if (!matched?.[1] || !matched[2]) {
          res.writeHead(404).end('not found')
          return
        }
        res.writeHead(200, { 'Content-Type': matched[1], 'Cache-Control': 'no-store' })
        res.end(method === 'HEAD' ? undefined : Buffer.from(matched[2], 'base64'))
        return
      }
      if (pathname !== '/' && pathname !== '/index.html') {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
      })
      res.end(
        method === 'HEAD'
          ? undefined
          : START_PAGE_HTML.replace('__INSPIN_STORED_SOURCES__', () => scriptJson(storedSources))
              .replace('__INSPIN_START_TOKEN__', () => scriptJson(startPageToken))
      )
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
        listSourceUrls: () =>
          (storedSources ?? SOURCES)
            .map((item) => normalizeSourceUrl(String((item as Record<string, unknown>).url ?? '')))
            .filter(Boolean),
        removeSource: (url) => {
          const target = normalizeSourceUrl(url).replace(/\/+$/, '')
          if (!target) return false
          const base = (storedSources ?? SOURCES) as Record<string, unknown>[]
          const next = base.filter(
            (item) => normalizeSourceUrl(String(item.url ?? '')).replace(/\/+$/, '') !== target
          )
          if (next.length === base.length) return false
          const parsed = normalizeStoredSources(next)
          if (!parsed) return false
          storedSources = parsed
          if (options.sourcesFile) writeStoredSources(options.sourcesFile, parsed)
          return true
        },
        addSource: async (favorite) => {
          const url = normalizeSourceUrl(favorite.url ?? '')
          if (!url) return false
          let hostname = ''
          try {
            hostname = new URL(url).hostname.replace(/^www\./, '')
          } catch {
            return false
          }
          const name = (favorite.title ?? '').trim().slice(0, 80) || hostname
          const id = `fav-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`
          let thumbnail: string | null =
            typeof favorite.favicon === 'string' &&
            favorite.favicon.startsWith('data:image/') &&
            favorite.favicon.length <= MAX_SOURCES_BODY
              ? favorite.favicon
              : null
          // 浏览器没给图标时，顺手抓一次站点的 apple-touch-icon
          if (!thumbnail) thumbnail = (await fetchSiteMeta(url)).icon

          const base = (storedSources ?? SOURCES) as Record<string, unknown>[]
          const exists = base.some((item) => normalizeSourceUrl(String(item.url ?? '')) === url)
          if (!exists && base.length >= MAX_SOURCES) return false

          const entry: Record<string, unknown> = { id, name, url }
          if (thumbnail) entry.thumbnail = thumbnail
          const next = base.filter((item) => normalizeSourceUrl(String(item.url ?? '')) !== url)
          next.push(entry)
          const parsed = normalizeStoredSources(next)
          if (!parsed) return false
          storedSources = parsed
          if (options.sourcesFile) writeStoredSources(options.sourcesFile, parsed)
          return true
        }
      })
    })
  })
}
