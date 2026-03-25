document.addEventListener("DOMContentLoaded", function() {
    
    // Seleccionamos todos los placeholders
    const placeholders = document.querySelectorAll('.video-placeholder');

    placeholders.forEach(placeholder => {
        placeholder.addEventListener('click', function() {
            const youtubeId = this.getAttribute('data-video-id');
            const vimeoId = this.getAttribute('data-vimeo-id');

            if (!youtubeId && !vimeoId) return;

            const iframe = document.createElement('iframe');

            if (vimeoId) {
                iframe.src = `https://player.vimeo.com/video/${vimeoId}?autoplay=1`;
                iframe.allow = "autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media";
                iframe.referrerPolicy = "strict-origin-when-cross-origin";
            } else {
                iframe.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1&rel=0`;
                iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
            }

            iframe.allowFullscreen = true;
            this.innerHTML = '';
            this.appendChild(iframe);
        });
    });
});