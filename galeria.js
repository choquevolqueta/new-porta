let slideIndex = 0;
const slides = document.querySelectorAll('.slide');
const counter = document.getElementById('photo-counter');

// Inicializar galería
showSlides(slideIndex);

// Función principal para cambiar slide
// n = 1 (siguiente) o n = -1 (anterior)
function changeSlide(n) {
    slideIndex += n;
    
    // Si llegamos al final, volvemos al principio (Loop)
    if (slideIndex >= slides.length) {
        slideIndex = 0;
    }
    // Si retrocedemos desde el principio, vamos al final
    if (slideIndex < 0) {
        slideIndex = slides.length - 1;
    }
    
    showSlides(slideIndex);
}

function showSlides(n) {
    // 1. Ocultar todas las fotos
    slides.forEach(slide => {
        slide.classList.remove('active');
    });

    // 2. Mostrar la foto actual
    slides[n].classList.add('active');

    // 3. Actualizar el contador de texto (Ej: 02 / 05)
    let current = (n + 1).toString().padStart(2, '0');
    let total = slides.length.toString().padStart(2, '0');
    
    counter.innerText = `${current} / ${total}`;
}

// Opcional: Permitir usar las flechas del teclado en PC
document.addEventListener('keydown', function(event) {
    if (event.key === "ArrowLeft") {
        changeSlide(-1);
    } else if (event.key === "ArrowRight") {
        changeSlide(1);
    }
    // Cerrar lightbox con ESC
    if (event.key === "Escape") {
        closeLightbox();
    }
});

// ─────────────────────────────────────────
// LIGHTBOX — Solo activo en escritorio (768px+)
// ─────────────────────────────────────────

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');

function isDesktop() {
    return window.matchMedia('(min-width: 768px)').matches;
}

// Agregar click a cada imagen del carrusel
slides.forEach(slide => {
    const img = slide.querySelector('img');
    img.addEventListener('click', function () {
        if (!isDesktop()) return; // En móvil no hace nada
        openLightbox(this.src, this.alt);
    });
});

function openLightbox(src, alt) {
    lightboxImg.src = src;
    lightboxImg.alt = alt;
    lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    lightbox.classList.remove('active');
    document.body.style.overflow = '';
}

// Cerrar al hacer click fuera de la imagen
lightbox.addEventListener('click', function(e) {
    if (e.target === lightbox) {
        closeLightbox();
    }
});
