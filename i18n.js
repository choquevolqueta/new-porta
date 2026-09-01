const translations = {
    es: {
        'nav.about': 'SOBRE MÍ',
        'nav.projects': 'PROYECTOS',
        'nav.skills': 'SKILLS',
        'nav.roadmap': 'ROADMAP',
        'nav.contact': 'CONTACTO',
        'hero.tagline': 'IA DEVELOPER',
        'hero.sub': 'Python · IA generativa · Para PYMES en Bolivia',
        'hero.lead': 'Automatizo el WhatsApp de tu negocio con agentes de IA',
        'hero.cta': 'Hablemos por Telegram',
        'about.title': 'SOBRE MÍ',
        'about.text': 'Nacido en Bolivia, radicado en Santiago. Empecé vibecodeando y hoy construyo herramientas propias con IA generativa: agentes, automatización y sistemas multiagente. Aprendo cada día y publico lo que voy construyendo.',
        'projects.title': 'PROYECTOS',
        'projects.view_repo': 'VER REPO ↗',
        'projects.view_demo': 'VER DEMO ↗',
        'projects.p1.title': 'AGENTE ADELITA V1',
        'projects.p1.tags': 'PYTHON · AGENTE IA · WHATSAPP',
        'projects.p1.desc': 'Agente de WhatsApp que edita precios en un afiche .PSD real (Photopea headless, sin Photoshop ni Canva) y responde con el JPG actualizado. Interacción en lenguaje natural, con confirmación previa e historial de precios en SQLite.',
        'projects.p2.title': 'AGENTE JURISPRUDENCIA TCP',
        'projects.p2.tags': 'RAG · FAISS · LEGAL TECH',
        'projects.p2.desc': 'Motor de búsqueda semántica sobre 538+ sentencias del Tribunal Constitucional Plurinacional de Bolivia. Ingiere la jurisprudencia, arma un grafo de citas y responde con referencias verificables. Demo pública en Hugging Face.',
        'projects.p3.title': 'IZI PEGA',
        'projects.p3.tags': 'EXTENSIÓN · AI · ATS',
        'projects.p3.desc': 'Extensión de Chrome + servidor local que usa IA (DeepSeek) para evaluar si una oferta laboral te conviene y rellenar formularios web con tu perfil para superar los filtros ATS. Todo corre local en tu máquina.',
        'projects.p4.title': 'GOEBBELS (ALFA)',
        'projects.p4.tags': 'SIMULACIÓN SOCIAL · MULTIAGENTE · MONITOREO',
        'projects.p4.desc': 'Loop de dos sistemas propios unidos por API: AlmaColectiva cosecha señal real del ecosistema digital (8 fuentes) y MiroFish, un motor de simulación social multiagente, se ancla a esos datos para proyectar escenarios contrafactuales — por ejemplo, cómo evolucionaría la conversación si arrestaran a Evo Morales. Ambos builds son partes del mismo alfa.',
        'skills.title': 'SKILLS',
        'roadmap.title': 'EN PROCESO',
        'roadmap.1': 'Conseguir certificación CS50P',
        'roadmap.2': 'Terminar set de extensiones de nodos para ComfyUI',
        'contact.title': 'CONTACTO'
    },
    en: {
        'nav.about': 'ABOUT',
        'nav.projects': 'PROJECTS',
        'nav.skills': 'SKILLS',
        'nav.roadmap': 'ROADMAP',
        'nav.contact': 'CONTACT',
        'hero.tagline': 'AI DEVELOPER',
        'hero.sub': 'Python · Generative AI · For SMEs in Bolivia',
        'hero.lead': "I automate your business WhatsApp with AI agents",
        'hero.cta': "Let's talk on Telegram",
        'about.title': 'ABOUT ME',
        'about.text': 'Born in Bolivia, based in Santiago. I started vibecoding and today I build my own tools with generative AI: agents, automation and multi-agent systems. I learn every day and ship what I build.',
        'projects.title': 'PROJECTS',
        'projects.view_repo': 'VIEW REPO ↗',
        'projects.view_demo': 'VIEW DEMO ↗',
        'projects.p1.title': 'ADELITA AGENT V1',
        'projects.p1.tags': 'PYTHON · AI AGENT · WHATSAPP',
        'projects.p1.desc': 'WhatsApp agent that edits prices on a real .PSD poster (headless Photopea, no Photoshop or Canva) and replies with the updated JPG. Natural-language interaction with prior confirmation and SQLite price history.',
        'projects.p2.title': 'TCP JURISPRUDENCE AGENT',
        'projects.p2.tags': 'RAG · FAISS · LEGAL TECH',
        'projects.p2.desc': 'Semantic search engine over 538+ rulings of the Plurinational Constitutional Court of Bolivia. It ingests the case law, builds a citation graph and answers with verifiable references. Public demo on Hugging Face.',
        'projects.p3.title': 'IZI PEGA',
        'projects.p3.tags': 'EXTENSION · AI · ATS',
        'projects.p3.desc': 'Chrome extension + local server that uses AI (DeepSeek) to assess whether a job offer suits you and auto-fill web forms with your profile to pass ATS filters. Everything runs locally on your machine.',
        'projects.p4.title': 'GOEBBELS (ALPHA)',
        'projects.p4.tags': 'SOCIAL SIMULATION · MULTI-AGENT · MONITORING',
        'projects.p4.desc': 'Loop of two in-house systems joined by API: AlmaColectiva harvests real signal from the digital ecosystem (8 sources) and MiroFish, a multi-agent social simulation engine, anchors itself to that data to project counterfactual scenarios — for example, how the conversation would evolve if Evo Morales were arrested. Both builds are parts of the same alpha.',
        'skills.title': 'SKILLS',
        'roadmap.title': 'IN PROGRESS',
        'roadmap.1': 'Get the CS50P certification',
        'roadmap.2': 'Finish the custom node set for ComfyUI',
        'contact.title': 'CONTACT'
    }
};

function setLanguage(lang) {
    if (!translations[lang]) return;

    sessionStorage.setItem('lang', lang);
    document.documentElement.lang = lang;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const value = translations[lang][key];
        if (value !== undefined) el.textContent = value;
    });

    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const savedLang = sessionStorage.getItem('lang') || 'es';
    setLanguage(savedLang);

    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setLanguage(btn.getAttribute('data-lang'));
        });
    });
});
