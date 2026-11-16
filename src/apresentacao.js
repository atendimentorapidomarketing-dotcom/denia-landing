// DENIA Platform — Apresentação institucional narrada (para empresas de médio e grande porte).
// O roteiro fica só aqui (o painel lê daqui). Cada cena tem a narração e os textos da tela, em português, inglês
// e espanhol. A narração é gerada uma única vez por idioma com a voz natural da OpenAI e fica guardada no banco:
// quem assiste depois não gera custo. Regra do roteiro: só fala do que a plataforma faz hoje — nada de números
// inventados, promessas de resultado ou comparação com concorrentes.

export const IDIOMAS_APRESENTACAO = { "pt-BR": "português do Brasil", en: "English", es: "español" };

// Estilo da narração: voz de apresentação de produto em evento corporativo, calma, segura e calorosa.
export const ESTILO_NARRACAO = {
  "pt-BR": "Narre como a apresentação de lançamento de um produto para diretores de grandes empresas: voz calorosa, segura e elegante, ritmo tranquilo, pausas curtas entre as frases, pronúncia impecável do português do Brasil. Sem exageros, sem tom de propaganda gritada e sem soar como robô. DENIA se pronuncia 'DÊ-nia'.",
  en: "Narrate like a product keynote for executives of global companies: warm, confident and elegant, unhurried pace, short pauses between sentences, flawless neutral English. No hype, no shouting, never robotic. DENIA is pronounced 'DEH-nee-ah'.",
  es: "Narra como la presentación de lanzamiento de un producto para directivos de grandes empresas: voz cálida, segura y elegante, ritmo pausado, pausas breves entre frases, español neutro impecable. Sin exageraciones ni tono de anuncio, nunca robótica. DENIA se pronuncia 'DÉ-nia'."
};

// visual: o desenho animado da cena no painel (abertura, atendimento, marketing, google, temporada, admin, financeiro, voz, global, seguranca, final).
export const CENAS = [
  {
    id: "abertura", visual: "abertura",
    "pt-BR": { titulo: "DENIA", subtitulo: "A inteligência que opera a sua empresa",
      narracao: "Toda empresa tem dois trabalhos. O que ela faz de melhor, e o que ela precisa fazer todos os dias para continuar de pé: atender, divulgar, cuidar da reputação, organizar a agenda, controlar o dinheiro. A DENIA nasceu para assumir esse segundo trabalho. Uma única plataforma, com inteligência artificial, que opera a rotina da empresa com você." },
    en: { titulo: "DENIA", subtitulo: "The intelligence that runs your business",
      narracao: "Every company has two jobs. The one it does best, and the one it has to do every single day just to keep going: serving customers, marketing, protecting its reputation, managing the schedule, controlling the money. DENIA was built to take on that second job. One platform, powered by artificial intelligence, that runs the company's daily operations alongside you." },
    es: { titulo: "DENIA", subtitulo: "La inteligencia que opera tu empresa",
      narracao: "Toda empresa tiene dos trabajos. El que mejor sabe hacer, y el que debe hacer todos los días para seguir adelante: atender, promocionar, cuidar la reputación, organizar la agenda, controlar el dinero. DENIA nació para asumir ese segundo trabajo. Una sola plataforma, con inteligencia artificial, que opera la rutina de la empresa junto a ti." }
  },
  {
    id: "atendimento", visual: "atendimento",
    "pt-BR": { titulo: "Atendimento que não dorme", subtitulo: "WhatsApp com inteligência artificial e equipe no mesmo fluxo",
      pontos: ["Responde como uma pessoa, com memória de cada cliente", "Menus com botões para quem prefere tocar", "Chama a equipe na hora certa, com aviso no Telegram", "Confirmação de entrega de cada mensagem"],
      narracao: "Começa pelo atendimento. No WhatsApp, a DENIA conversa como uma pessoa da sua equipe, se lembra de cada cliente, tira dúvidas, organiza pedidos e agenda serviços, a qualquer hora. Quando o assunto pede um humano, ela chama a equipe na hora, com o histórico completo. E cada mensagem tem a entrega confirmada: nada se perde no caminho." },
    en: { titulo: "Customer service that never sleeps", subtitulo: "WhatsApp with artificial intelligence and your team in the same flow",
      pontos: ["Replies like a person, remembering every customer", "Button menus for those who prefer to tap", "Brings in your team at the right moment, with Telegram alerts", "Delivery confirmation for every message"],
      narracao: "It starts with customer service. On WhatsApp, DENIA talks like a member of your team, remembers every customer, answers questions, organizes requests and books services, at any hour. When a conversation needs a human, it brings in your team right away, with the full history. And every message has confirmed delivery: nothing gets lost along the way." },
    es: { titulo: "Atención que nunca duerme", subtitulo: "WhatsApp con inteligencia artificial y tu equipo en el mismo flujo",
      pontos: ["Responde como una persona, con memoria de cada cliente", "Menús con botones para quien prefiere tocar", "Llama al equipo en el momento justo, con aviso en Telegram", "Confirmación de entrega de cada mensaje"],
      narracao: "Todo empieza por la atención. En WhatsApp, DENIA conversa como una persona de tu equipo, recuerda a cada cliente, resuelve dudas, organiza pedidos y agenda servicios, a cualquier hora. Cuando el tema necesita a una persona, llama al equipo en el acto, con todo el historial. Y cada mensaje tiene la entrega confirmada: nada se pierde en el camino." }
  },
  {
    id: "marketing", visual: "marketing",
    "pt-BR": { titulo: "Marketing de especialista, todos os dias", subtitulo: "Instagram, Facebook e Google em um só calendário",
      pontos: ["Planeja a semana e escreve cada post", "Cria artes com o logo e as cores da marca", "Publica sozinha no horário aprovado", "Responde comentários e mostra o que funciona"],
      narracao: "No marketing, a DENIA trabalha como uma agência inteira. Ela planeja a semana de cada marca, escreve as legendas, cria as artes com o seu logo e as suas cores, e publica no Instagram, no Facebook e no Google no horário certo. Você aprova com um toque, ou deixa no automático. Os comentários chegam em uma fila única, com a resposta sugerida, e os números mostram com clareza o que está funcionando." },
    en: { titulo: "Expert marketing, every day", subtitulo: "Instagram, Facebook and Google in a single calendar",
      pontos: ["Plans the week and writes every post", "Designs artwork with the brand's logo and colors", "Publishes on its own at the approved time", "Answers comments and shows what works"],
      narracao: "In marketing, DENIA works like an entire agency. It plans each brand's week, writes the captions, designs the artwork with your logo and colors, and publishes to Instagram, Facebook and Google at the right time. You approve with a single tap, or let it run on autopilot. Comments arrive in one queue with a suggested reply, and the numbers show clearly what is working." },
    es: { titulo: "Marketing de experto, todos los días", subtitulo: "Instagram, Facebook y Google en un solo calendario",
      pontos: ["Planifica la semana y escribe cada publicación", "Crea piezas con el logo y los colores de la marca", "Publica sola en el horario aprobado", "Responde comentarios y muestra lo que funciona"],
      narracao: "En marketing, DENIA trabaja como una agencia completa. Planifica la semana de cada marca, escribe los textos, crea las piezas con tu logo y tus colores, y publica en Instagram, Facebook y Google en el momento justo. Apruebas con un toque, o lo dejas en automático. Los comentarios llegan en una sola fila, con la respuesta sugerida, y los números muestran con claridad lo que está funcionando." }
  },
  {
    id: "google", visual: "google",
    "pt-BR": { titulo: "Reputação que se cuida sozinha", subtitulo: "Perfil da empresa no Google",
      pontos: ["Avaliações respondidas no tom da marca", "Triagem das suspeitas, com o caminho certo de denúncia", "Até 18 meses de desempenho e as buscas que trazem clientes", "Posição no mapa e comparação com concorrentes"],
      narracao: "A reputação também está em boas mãos. Cada avaliação no Google recebe uma resposta pensada, no tom da sua marca. As suspeitas passam por triagem, com o caminho certo para denunciar. E você enxerga até dezoito meses de desempenho, as buscas que levam clientes até você, a sua posição no mapa e como você está diante dos concorrentes." },
    en: { titulo: "A reputation that looks after itself", subtitulo: "Your Google Business Profile",
      pontos: ["Reviews answered in the brand's voice", "Suspicious reviews screened, with the right path to report them", "Up to 18 months of performance and the searches that bring customers", "Map ranking and competitor comparison"],
      narracao: "Your reputation is in good hands too. Every Google review receives a thoughtful reply, in your brand's voice. Suspicious reviews are screened, with the right path to report them. And you see up to eighteen months of performance, the searches that lead customers to you, your position on the map, and how you compare with your competitors." },
    es: { titulo: "Una reputación que se cuida sola", subtitulo: "El perfil de la empresa en Google",
      pontos: ["Reseñas respondidas con el tono de la marca", "Filtro de las sospechosas, con el camino correcto para denunciarlas", "Hasta 18 meses de desempeño y las búsquedas que traen clientes", "Posición en el mapa y comparación con la competencia"],
      narracao: "Tu reputación también está en buenas manos. Cada reseña en Google recibe una respuesta pensada, con el tono de tu marca. Las sospechosas pasan por un filtro, con el camino correcto para denunciarlas. Y ves hasta dieciocho meses de desempeño, las búsquedas que llevan clientes hasta ti, tu posición en el mapa y cómo estás frente a la competencia." }
  },
  {
    id: "temporada", visual: "temporada",
    "pt-BR": { titulo: "Locação por temporada no piloto automático", subtitulo: "Airbnb, Booking.com e Vrbo em um só lugar",
      pontos: ["Calendário e preços de todos os imóveis", "Mensagens dos hóspedes com tradução e resposta sugerida", "Limpezas com checklist, fotos e estoque", "Avaliações dos hóspedes respondidas"],
      narracao: "Para quem administra imóveis por temporada, a DENIA reúne Airbnb, Booking e Vrbo em um só lugar. Calendário e preços de todos os imóveis, mensagens dos hóspedes traduzidas e com resposta sugerida, limpezas organizadas com checklist e fotos, controle do estoque de cada apartamento e as avaliações respondidas. É a operação inteira, em uma tela." },
    en: { titulo: "Short-term rentals on autopilot", subtitulo: "Airbnb, Booking.com and Vrbo in one place",
      pontos: ["Calendar and pricing for every property", "Guest messages translated, with suggested replies", "Cleanings with checklists, photos and inventory", "Guest reviews answered"],
      narracao: "For those who manage short-term rentals, DENIA brings Airbnb, Booking and Vrbo together in one place. Calendars and pricing for every property, guest messages translated with suggested replies, cleanings organized with checklists and photos, inventory control for each unit, and guest reviews answered. The entire operation, on a single screen." },
    es: { titulo: "Alquiler temporario en piloto automático", subtitulo: "Airbnb, Booking.com y Vrbo en un solo lugar",
      pontos: ["Calendario y precios de todas las propiedades", "Mensajes de huéspedes traducidos y con respuesta sugerida", "Limpiezas con checklist, fotos e inventario", "Reseñas de huéspedes respondidas"],
      narracao: "Para quienes administran alquileres temporarios, DENIA reúne Airbnb, Booking y Vrbo en un solo lugar. Calendario y precios de todas las propiedades, mensajes de huéspedes traducidos y con respuesta sugerida, limpiezas organizadas con checklist y fotos, control del inventario de cada departamento y las reseñas respondidas. Toda la operación, en una sola pantalla." }
  },
  {
    id: "administracao", visual: "admin",
    "pt-BR": { titulo: "Uma administradora inteira, dentro da plataforma", subtitulo: "Agenda executiva, tarefas e obrigações",
      pontos: ["Escreva ou fale: \"vistoria terça às dez\" — e está marcado", "Tarefas com responsável, prazo e lembrete", "Google Agenda integrado e avisos no celular", "Manutenção, documentos e prazos em dia"],
      narracao: "E agora, a administração. Basta escrever ou falar: vistoria na terça às dez. Pronto, está na agenda, com aviso para o responsável. Tarefas com prazo e checklist, a agenda do Google integrada, os compromissos de todas as empresas em uma única visão, e as obrigações do prédio, os contratos e os documentos com aviso antes de vencer." },
    en: { titulo: "A complete management office, inside the platform", subtitulo: "Executive calendar, tasks and obligations",
      pontos: ["Type or say: \"inspection Tuesday at ten\" — and it's booked", "Tasks with an owner, a deadline and reminders", "Google Calendar integrated, with alerts on your phone", "Maintenance, documents and deadlines kept up to date"],
      narracao: "And now, management. Just type or say: inspection on Tuesday at ten. Done, it's on the calendar, with an alert for the person in charge. Tasks with deadlines and checklists, Google Calendar integrated, appointments from every company in a single view, and building maintenance, contracts and documents with alerts before they expire." },
    es: { titulo: "Una administración completa, dentro de la plataforma", subtitulo: "Agenda ejecutiva, tareas y obligaciones",
      pontos: ["Escribe o di: \"inspección el martes a las diez\" — y queda agendado", "Tareas con responsable, plazo y recordatorio", "Google Calendar integrado y avisos en el celular", "Mantenimiento, documentos y plazos al día"],
      narracao: "Y ahora, la administración. Solo escribe o di: inspección el martes a las diez. Listo, queda en la agenda, con aviso para el responsable. Tareas con plazo y checklist, Google Calendar integrado, las citas de todas las empresas en una sola vista, y el mantenimiento del edificio, los contratos y los documentos con aviso antes de vencer." }
  },
  {
    id: "financeiro", visual: "financeiro",
    "pt-BR": { titulo: "Financeiro preciso, do lançamento ao relatório assinado", subtitulo: "Banco, caixa, aluguéis e fluxo de caixa",
      pontos: ["Banco e dinheiro em espécie separados, até o último centavo", "Pagamentos divididos, contas que se repetem e comprovantes anexados", "Aluguéis com multa, juros e reajuste pelo índice oficial", "Fluxo de caixa de 12 meses e relatório pronto para assinar"],
      narracao: "No financeiro, a precisão é absoluta. Banco e dinheiro em espécie separados até o último centavo. Pagamentos divididos entre Pix, dinheiro e cartão, contas que se repetem sozinhas, comprovantes anexados e até o extrato lido por foto. Nos aluguéis, multa e juros são calculados na hora, e o reajuste segue o índice oficial. Você vê o fluxo de caixa dos próximos doze meses e tem, todo mês, o relatório pronto para assinar." },
    en: { titulo: "Precise finance, from entry to signed report", subtitulo: "Bank, cash, rentals and cash flow",
      pontos: ["Bank and cash kept separate, down to the last cent", "Split payments, recurring bills and attached receipts", "Rent with late fees, interest and official index adjustments", "12-month cash flow and a report ready to sign"],
      narracao: "In finance, precision is absolute. Bank and cash kept separate, down to the last cent. Payments split between instant transfer, cash and card, recurring bills that create themselves, receipts attached, and even bank statements read from a photo. For rentals, late fees and interest are calculated instantly, and adjustments follow the official index. You see your cash flow for the next twelve months and every month, a report is ready to sign." },
    es: { titulo: "Finanzas precisas, del registro al informe firmado", subtitulo: "Banco, caja, alquileres y flujo de caja",
      pontos: ["Banco y efectivo separados, hasta el último centavo", "Pagos divididos, cuentas recurrentes y comprobantes adjuntos", "Alquileres con mora, intereses y reajuste por el índice oficial", "Flujo de caja de 12 meses e informe listo para firmar"],
      narracao: "En las finanzas, la precisión es absoluta. Banco y efectivo separados hasta el último centavo. Pagos divididos entre transferencia, efectivo y tarjeta, cuentas que se repiten solas, comprobantes adjuntos e incluso el extracto leído desde una foto. En los alquileres, la mora y los intereses se calculan al instante, y el reajuste sigue el índice oficial. Ves el flujo de caja de los próximos doce meses y cada mes tienes el informe listo para firmar." }
  },
  {
    id: "voz", visual: "voz",
    "pt-BR": { titulo: "Fale com a DENIA", subtitulo: "Uma conversa por voz, ao vivo — e ela executa",
      narracao: "Tudo isso também por voz. Você conversa com a DENIA ao vivo, como falaria com uma colega brilhante. Peça os posts da semana, pergunte como foi o atendimento de ontem, marque um compromisso. Ela responde, executa, e você acompanha cada passo acontecendo na tela." },
    en: { titulo: "Talk to DENIA", subtitulo: "A live voice conversation — and it gets things done",
      narracao: "All of this by voice, too. You talk to DENIA live, just as you would with a brilliant colleague. Ask for this week's posts, ask how yesterday's customer service went, book an appointment. It answers, takes action, and you watch every step happen on screen." },
    es: { titulo: "Habla con DENIA", subtitulo: "Una conversación por voz, en vivo — y ella ejecuta",
      narracao: "Todo esto también por voz. Conversas con DENIA en vivo, como lo harías con una colega brillante. Pide las publicaciones de la semana, pregunta cómo fue la atención de ayer, agenda una cita. Ella responde, ejecuta, y ves cada paso sucediendo en la pantalla." }
  },
  {
    id: "global", visual: "global",
    "pt-BR": { titulo: "Pronta para operar em escala global", subtitulo: "Várias empresas, marcas e países em um só painel",
      pontos: ["Oito idiomas no painel e no conteúdo", "Moeda e fuso horário de cada operação", "Dados de cada empresa separados e protegidos", "Perfis de acesso por pessoa e auditoria completa"],
      narracao: "E a DENIA foi construída para crescer com você. Grupos, franquias e multinacionais operam várias empresas e marcas em um só painel, cada uma com os seus dados separados, a sua moeda e o seu fuso horário. São oito idiomas, no painel e no conteúdo. Cada pessoa vê apenas o que deve, e as ações ficam registradas em auditoria." },
    en: { titulo: "Ready to operate at global scale", subtitulo: "Multiple companies, brands and countries in a single dashboard",
      pontos: ["Eight languages in the dashboard and in content", "The currency and time zone of each operation", "Each company's data kept separate and protected", "Role-based access and a complete audit trail"],
      narracao: "And DENIA was built to grow with you. Groups, franchises and multinationals run multiple companies and brands from a single dashboard, each with its own separate data, its own currency and its own time zone. Eight languages, in the dashboard and in the content. Each person sees only what they should, and actions are recorded in an audit trail." },
    es: { titulo: "Lista para operar a escala global", subtitulo: "Varias empresas, marcas y países en un solo panel",
      pontos: ["Ocho idiomas en el panel y en el contenido", "Moneda y huso horario de cada operación", "Datos de cada empresa separados y protegidos", "Perfiles de acceso por persona y auditoría completa"],
      narracao: "Y DENIA fue construida para crecer contigo. Grupos, franquicias y multinacionales operan varias empresas y marcas en un solo panel, cada una con sus datos separados, su moneda y su huso horario. Son ocho idiomas, en el panel y en el contenido. Cada persona ve solo lo que debe, y las acciones quedan registradas en una auditoría." }
  },
  {
    id: "seguranca", visual: "seguranca",
    "pt-BR": { titulo: "Inteligência com responsabilidade", subtitulo: "Na dúvida, a DENIA não age: chama a sua equipe",
      pontos: ["Age apenas sobre fatos confirmados", "Chaves guardadas com criptografia", "Dados tratados conforme a LGPD", "Travas e pausa imediata de toda a operação"],
      narracao: "Por trás de tudo, um princípio simples: a DENIA age apenas sobre fatos confirmados. Ela não inventa dados e, na dúvida, chama a sua equipe. As chaves ficam guardadas com criptografia, os dados são tratados conforme a Lei Geral de Proteção de Dados, e um único botão pausa toda a operação, quando você quiser." },
    en: { titulo: "Intelligence with responsibility", subtitulo: "When in doubt, DENIA doesn't act: it calls your team",
      pontos: ["Acts only on confirmed facts", "Credentials stored with encryption", "Data handled in line with data protection law", "Safeguards and an instant pause for the entire operation"],
      narracao: "Behind it all lies a simple principle: DENIA acts only on confirmed facts. It never makes up data and, when in doubt, it calls your team. Credentials are stored with encryption, data is handled in line with data protection law, and a single button pauses the entire operation, whenever you choose." },
    es: { titulo: "Inteligencia con responsabilidad", subtitulo: "Ante la duda, DENIA no actúa: llama a tu equipo",
      pontos: ["Actúa solo sobre hechos confirmados", "Claves guardadas con cifrado", "Datos tratados conforme a la ley de protección de datos", "Bloqueos y pausa inmediata de toda la operación"],
      narracao: "Detrás de todo hay un principio simple: DENIA actúa solo sobre hechos confirmados. No inventa datos y, ante la duda, llama a tu equipo. Las claves se guardan con cifrado, los datos se tratan conforme a la ley de protección de datos, y un solo botón pausa toda la operación, cuando lo decidas." }
  },
  {
    id: "final", visual: "final",
    "pt-BR": { titulo: "DENIA", subtitulo: "A sua empresa, operando no próximo nível.", chamada: "denia-ai.com",
      narracao: "Atendimento, marketing, reputação, temporada, administração e finanças. Uma única inteligência, trabalhando todos os dias pela sua empresa. DENIA. A sua empresa, operando no próximo nível." },
    en: { titulo: "DENIA", subtitulo: "Your company, operating at the next level.", chamada: "denia-ai.com",
      narracao: "Customer service, marketing, reputation, short-term rentals, management and finance. One single intelligence, working every day for your company. DENIA. Your company, operating at the next level." },
    es: { titulo: "DENIA", subtitulo: "Tu empresa, operando en el siguiente nivel.", chamada: "denia-ai.com",
      narracao: "Atención, marketing, reputación, alquileres temporarios, administración y finanzas. Una sola inteligencia, trabajando todos los días por tu empresa. DENIA. Tu empresa, operando en el siguiente nivel." }
  }
];

export function roteiro(idioma) {
  const i = IDIOMAS_APRESENTACAO[idioma] ? idioma : "pt-BR";
  return { idioma: i, idiomas: Object.keys(IDIOMAS_APRESENTACAO), cenas: CENAS.map((c, n) => ({ n, id: c.id, visual: c.visual, ...c[i] })) };
}

// Identificador do áudio: muda sozinho se o texto da cena (ou a voz) mudar — aí a narração é gerada de novo.
export async function chaveAudio(idioma, n, voz, modelo) {
  const c = CENAS[n]; if (!c) return null;
  const texto = `${voz}|${modelo}|${ESTILO_NARRACAO[idioma]}|${c[idioma].narracao}`;
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

const DDL = "CREATE TABLE IF NOT EXISTS plt_apresentacao_audio (chave TEXT PRIMARY KEY, idioma TEXT, cena INTEGER, mime TEXT, dados TEXT NOT NULL, criado_ms INTEGER)";
const pronto = new WeakSet();

// GET /api/orgs/:id/apresentacao  → roteiro; GET /api/orgs/:id/apresentacao/audio?idioma=&cena= → mp3 (guardado).
export async function rotasApresentacao(request, env, k, orgId, resto) {
  const { json } = k;
  const url = new URL(request.url);
  const idioma = IDIOMAS_APRESENTACAO[url.searchParams.get("idioma")] ? url.searchParams.get("idioma") : "pt-BR";
  if (resto === "apresentacao" && request.method === "GET") return json(roteiro(idioma));
  if (resto === "apresentacao/audio" && request.method === "GET") {
    if (!pronto.has(env.DB)) { await env.DB.prepare(DDL).run(); pronto.add(env.DB); }
    const n = Number(url.searchParams.get("cena"));
    if (!Number.isInteger(n) || !CENAS[n]) return json({ erro: "Cena inválida." }, 400);
    const voz = String(env.APRESENTACAO_VOZ || "marin"), modelo = String(env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts");
    const chave = await chaveAudio(idioma, n, voz, modelo);
    let a = await env.DB.prepare("SELECT mime, dados FROM plt_apresentacao_audio WHERE chave=?").bind(chave).first();
    if (!a) {
      // Gera uma vez (com a chave da OpenAI da plataforma) e guarda para todo mundo.
      const envIA = await k.comIA(env, orgId);
      if (!String(envIA.OPENAI_API_KEY || "").trim()) return json({ erro: "A narração precisa da chave da OpenAI (Integrações). Sem ela, a apresentação passa com legendas.", codigo: "SEM_CHAVE" }, 503);
      let r;
      try {
        r = await k.openai(envIA, "audio/speech", { model: modelo, voice: voz, input: CENAS[n][idioma].narracao, response_format: "mp3", instructions: ESTILO_NARRACAO[idioma] }, { binario: true, timeout: 90000 });
      } catch (e) { return json({ erro: "Não foi possível gerar a narração agora: " + (e?.message || e) }, 502); }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length < 1000) return json({ erro: "A narração veio vazia. Tente de novo." }, 502);
      let b64 = ""; for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      a = { mime: "audio/mpeg", dados: btoa(b64) };
      await env.DB.prepare("INSERT OR REPLACE INTO plt_apresentacao_audio(chave,idioma,cena,mime,dados,criado_ms) VALUES(?,?,?,?,?,?)").bind(chave, idioma, n, a.mime, a.dados, Date.now()).run();
    }
    const bin = Uint8Array.from(atob(a.dados), c => c.charCodeAt(0));
    return new Response(bin, { headers: { "content-type": a.mime, "cache-control": "private, max-age=86400", "content-length": String(bin.length) } });
  }
  return null;
}
