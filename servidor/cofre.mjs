// Arquivos grandes (vídeos dos posts) guardados em disco, na pasta de dados, fora do banco.
// Interface pequena, parecida com um bucket: put / get (com faixa de bytes, para o player do navegador) / delete.
import path from "node:path";
import { mkdirSync, createReadStream, createWriteStream, statSync, rmSync, existsSync, renameSync } from "node:fs";
import { Readable } from "node:stream";

export function criarCofre(pasta) {
  mkdirSync(pasta, { recursive: true });
  const caminho = chave => {
    const limpa = String(chave || "").replace(/[^a-zA-Z0-9/_.-]/g, "").replace(/\.\.+/g, ".");
    if (!limpa || limpa.startsWith("/")) throw new Error("chave inválida");
    return path.join(pasta, limpa);
  };
  return {
    // corpo: ReadableStream da web ou bytes. Acima do limite, apaga o pedaço gravado e falha.
    async put(chave, corpo, { limite = Infinity } = {}) {
      const destino = caminho(chave), temp = destino + ".parcial";
      mkdirSync(path.dirname(destino), { recursive: true });
      const saida = createWriteStream(temp);
      let total = 0;
      try {
        if (corpo instanceof Uint8Array || corpo instanceof ArrayBuffer) {
          const b = corpo instanceof ArrayBuffer ? new Uint8Array(corpo) : corpo;
          total = b.length; if (total > limite) throw Object.assign(new Error("grande demais"), { grande: true });
          await new Promise((ok, erro) => saida.end(Buffer.from(b), e => e ? erro(e) : ok()));
        } else {
          for await (const parte of Readable.fromWeb(corpo)) {
            total += parte.length;
            if (total > limite) throw Object.assign(new Error("grande demais"), { grande: true });
            if (!saida.write(parte)) await new Promise(ok => saida.once("drain", ok));
          }
          await new Promise((ok, erro) => saida.end(e => e ? erro(e) : ok()));
        }
        renameSync(temp, destino);
        return { tamanho: total };
      } catch (e) { saida.destroy(); rmSync(temp, { force: true }); throw e; }
    },
    async get(chave, { inicio, fim } = {}) {
      const arq = caminho(chave);
      if (!existsSync(arq)) return null;
      const tamanho = statSync(arq).size;
      const ini = Number.isFinite(inicio) ? Math.max(0, inicio) : 0, ult = Number.isFinite(fim) ? Math.min(fim, tamanho - 1) : tamanho - 1;
      return { tamanho, inicio: ini, fim: ult, body: Readable.toWeb(createReadStream(arq, { start: ini, end: ult })) };
    },
    async delete(chave) { rmSync(caminho(chave), { force: true }); }
  };
}
