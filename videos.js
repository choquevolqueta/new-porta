document.addEventListener("DOMContentLoaded", function() {
    
    // Seleccionamos todos los placeholders
    const placeholders = document.querySelectorAll('.video-placeholder');

    placeholders.forEach(placeholder => {
        placeholder.addEventListener('click', function() {
            
            // 1. Obtenemos el ID del video guardado en el HTML
            const videoId = this.getAttribute('data-video-id');
            
            // 2. Si no hay ID, no hacemos nada (por seguridad)
            if (!videoId) return;

            // 3. Creamos el elemento iframe de Youtube
            const iframe = document.createElement('iframe');
            
            // URL mágica: autoplay=1 hace que arranque solo
            iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
            
            // Permisos necesarios para fullscreen y autoplay
            iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
            iframe.allowFullscreen = true;

            // 4. Limpiamos el placeholder (borramos imagen y botón)
            this.innerHTML = '';
            
            // 5. Agregamos el iframe
            this.appendChild(iframe);
        });
    });
});