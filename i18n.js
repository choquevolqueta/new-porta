const translations = {
    es: {
        'splash.title': 'VER PORTAFOLIO',
        'splash.hint': '(HAZ CLIC EN CUALQUIER LUGAR)',
        'project.photo': 'FOTOGRAFÍA',
        'project.video': 'VIDEOS',
        'project.ads': 'PUBLICIDAD',
        'bio.role': 'PUBLICISTA DE PROFESIÓN, AUDIOVISUAL DE CORAZÓN',
        'bio.text': 'Nacido en Bolivia, radicado en Santiago hace 8 meses. Me especializo en generación de videos mediante IA y fotografía de retrato — aunque, escucha bien: puedo armar hasta páginas web y agentes automatizados de ventas si me dan el incentivo adecuado.',
        'bio.location': '— SANTIAGO, CHILE',

        'nav.back': 'VOLVER',
        'nav.back-arrow': '← VOLVER',
        'nav.tag.audiovisual': 'AUDIOVISUAL',
        'nav.tag.advertising': 'PUBLICIDAD',

        'gallery.cap.portrait': 'RETRATO',
        'gallery.cap.documentary': 'REGISTRO',
        'gallery.cap.exposure': 'DOBLE EXPOSICIÓN',
        'gallery.cap.action': 'ACCIÓN',

        'videos.title': 'MIS VIDEOS',
        'videos.btn.play': 'PLAY',
        'videos.btn.yt': 'VER EN YOUTUBE',
        'videos.btn.ig': 'VER EN IG ↗',

        'ads.title': 'CUENTAS',
        'ads.frial.role': 'DISEÑO DE MARCA · ESTRATEGIA DE MEDIOS',
        'ads.frial.desc': 'Frial Adelita, el negocio familiar, pasaba un duro momento durante la pandemia. Ayudé usando todo mi conocimiento en marketing (y aún sigo ayudando desde la distancia) haciendo una construcción de marca desde cero: logo nuevo, color de marca, lista de precios online, cuenta de TikTok y WhatsApp corporativo.',
        'ads.frial.stat1': '+30% crecimiento en ventas sostenido',
        'ads.frial.stat2': 'Alta tasa de retención de clientes',
        'ads.frial.stat3': 'Marca líder en venta de carne de cerdo en Chasquipampa',
        'ads.inv.role': 'CAMPAÑA SUBLIMACIÓN · ARTES DIGITALES',
        'ads.inv.desc': 'Inventados Industria Gráfica lanzó un nuevo servicio: la impresión por sublimación. Como encargado de la campaña, diseñé los artes digitales inspirado en los anuncios de revista de los años 50 y redacté los textos en un tono coloquial y amable, destacando los beneficios del servicio.',
        'ads.inv.stat1': 'Lanzamiento exitoso en Facebook',
        'ads.inv.stat2': 'Interés de nuevos clientes',
        'ads.inv.stat3': 'Ampliación de servicios con clientes recurrentes',
        'ads.jhedai.role': 'GESTIÓN DE REDES · CONTENIDO AUDIOVISUAL',
        'ads.jhedai.desc': 'Como parte del equipo creativo de Jhedai (consultora de inteligencia artificial), genero contenido audiovisual y visual para reactivar sus redes sociales junto a otro colaborador.',
        'ads.jhedai.stat1': 'Reactivación de cuentas en redes',
        'ads.jhedai.stat2': 'Producción de contenido audiovisual',
        'ads.jhedai.stat3': 'Trabajo colaborativo en estrategia',
        'ads.btn.view': 'VER CUENTA ↗'
    },
    en: {
        'splash.title': 'VIEW PORTFOLIO',
        'splash.hint': '(CLICK ANYWHERE)',
        'project.photo': 'PHOTOGRAPHY',
        'project.video': 'VIDEOS',
        'project.ads': 'ADVERTISING',
        'bio.role': 'ADVERTISER BY TRADE, FILMMAKER AT HEART',
        'bio.text': 'Born in Bolivia, based in Santiago for the past 8 months. I specialize in AI-generated video and portrait photography — though, hear me out: I can also build websites and automated sales agents if the incentive is right.',
        'bio.location': '— SANTIAGO, CHILE',

        'nav.back': 'BACK',
        'nav.back-arrow': '← BACK',
        'nav.tag.audiovisual': 'AUDIOVISUAL',
        'nav.tag.advertising': 'ADVERTISING',

        'gallery.cap.portrait': 'PORTRAIT',
        'gallery.cap.documentary': 'DOCUMENTARY',
        'gallery.cap.exposure': 'DOUBLE EXPOSURE',
        'gallery.cap.action': 'ACTION',

        'videos.title': 'MY VIDEOS',
        'videos.btn.play': 'PLAY',
        'videos.btn.yt': 'WATCH ON YOUTUBE',
        'videos.btn.ig': 'WATCH ON IG ↗',

        'ads.title': 'ACCOUNTS',
        'ads.frial.role': 'BRAND DESIGN · MEDIA STRATEGY',
        'ads.frial.desc': 'Frial Adelita, the family business, was going through a tough time during the pandemic. I helped using all my marketing knowledge (and still help from a distance) by building the brand from scratch: new logo, brand colors, online price list, TikTok account and corporate WhatsApp.',
        'ads.frial.stat1': '+30% sustained sales growth',
        'ads.frial.stat2': 'High customer retention rate',
        'ads.frial.stat3': 'Leading pork brand in Chasquipampa',
        'ads.inv.role': 'SUBLIMATION CAMPAIGN · DIGITAL ART',
        'ads.inv.desc': 'Inventados Industria Gráfica launched a new service: sublimation printing. As campaign lead, I designed the digital art inspired by 1950s magazine ads and wrote the copy in a casual, friendly tone highlighting the service\'s benefits.',
        'ads.inv.stat1': 'Successful launch on Facebook',
        'ads.inv.stat2': 'New client interest',
        'ads.inv.stat3': 'Expanded services with recurring clients',
        'ads.jhedai.role': 'SOCIAL MEDIA · AUDIOVISUAL CONTENT',
        'ads.jhedai.desc': 'As part of Jhedai\'s creative team (an AI consultancy), I produce audiovisual and visual content to reactivate their social media presence, working alongside another collaborator.',
        'ads.jhedai.stat1': 'Social media reactivation',
        'ads.jhedai.stat2': 'Audiovisual content production',
        'ads.jhedai.stat3': 'Collaborative content strategy',
        'ads.btn.view': 'VIEW ACCOUNT ↗'
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
