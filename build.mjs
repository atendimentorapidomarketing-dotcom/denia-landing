import { rm, mkdir, cp } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await cp('site', 'dist', { recursive: true })
console.log('DENIA landing build concluído em /dist')
