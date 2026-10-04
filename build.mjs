import { rm, mkdir, copyFile } from 'node:fs/promises'
const files=['index.html','styles.css','script.js','auth.css','login.html','cadastro.html','app.css','app.html','app.js']
await rm('dist',{recursive:true,force:true})
await mkdir('dist',{recursive:true})
for(const file of files) await copyFile(file,`dist/${file}`)
console.log('DENIA Platform V8 Immersive Team build concluído em /dist')
