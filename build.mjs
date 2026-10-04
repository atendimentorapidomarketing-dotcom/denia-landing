import { rm, mkdir, copyFile } from 'node:fs/promises'

const files = ['index.html', 'styles.css', 'script.js']

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

for (const file of files) {
  await copyFile(file, `dist/${file}`)
}

console.log('DENIA landing V5 build concluído em /dist')
