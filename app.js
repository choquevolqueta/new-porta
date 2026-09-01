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

});