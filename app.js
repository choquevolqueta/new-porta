document.addEventListener('DOMContentLoaded', function () {

    // Reveal on scroll
    const revealEls = document.querySelectorAll('section');
    const io = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15 });
    revealEls.forEach(el => el.classList.add('reveal'));
    revealEls.forEach(el => io.observe(el));

    // Nav: marcar la sección activa al hacer scroll
    const sections = document.querySelectorAll('section[id], footer[id]');
    const navLinks = document.querySelectorAll('.nav-links a');

    const spy = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                navLinks.forEach(a => {
                    a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id);
                });
            }
        });
    }, { rootMargin: '-45% 0px -45% 0px' });
    sections.forEach(s => spy.observe(s));

    // Modal de video de proyectos
    const modal = document.querySelector('.video-modal');
    const modalContainer = document.querySelector('.video-modal-container');
    const closeBtn = modal.querySelector('.video-modal-close');
    let lastTrigger = null;

    function openVideoModal(videos) {
        modalContainer.innerHTML = '';
        videos.forEach(src => {
            const video = document.createElement('video');
            video.src = src;
            video.controls = true;
            video.playsInline = true;
            video.preload = 'metadata';
            modalContainer.appendChild(video);
        });
        modal.hidden = false;
        closeBtn.focus();
    }

    function closeVideoModal() {
        modalContainer.querySelectorAll('video').forEach(v => {
            v.pause();
            v.removeAttribute('src');
            v.load();
        });
        modalContainer.innerHTML = '';
        modal.hidden = true;
        if (lastTrigger) lastTrigger.focus();
    }

    document.addEventListener('click', event => {
        const trigger = event.target.closest('.project-video-btn');
        if (trigger) {
            lastTrigger = trigger;
            const videos = trigger.dataset.videos.split('|').map(s => s.trim()).filter(Boolean);
            if (videos.length) openVideoModal(videos);
            return;
        }
        if (event.target.closest('[data-close]') && !modal.hidden) {
            closeVideoModal();
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !modal.hidden) {
            closeVideoModal();
        }
    });

});