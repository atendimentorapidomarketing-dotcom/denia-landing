import { rm, mkdir, copyFile } from 'node:fs/promises'
const files=[
'index.html','index-en.html','index-es.html',
'styles.css','script.js',
'auth.css','login.html','login-en.html','login-es.html',
'cadastro.html','cadastro-en.html','cadastro-es.html',
'app.css','app.html','app-en.html','app-es.html','app.js'
]
await rm('dist',{recursive:true,force:true})
await mkdir('dist',{recursive:true})
for(const file of files) await copyFile(file,`dist/${file}`)
console.log('DENIA Platform V10 Functional build concluído em /dist')
