document.addEventListener("DOMContentLoaded", function() {
    
    // 1. Seleccionamos los elementos
    const splashScreen = document.getElementById('splash-screen');
    const mainContent = document.getElementById('main-content');
    const video = document.getElementById('portfolio-video');

    // 2. LÓGICA INTELIGENTE: ¿Ya vimos la intro en esta sesión?
    if (sessionStorage.getItem('introVisto') === 'true') {
        
        // --- CASO A: EL USUARIO YA LO VIO (Está volviendo de otra página) ---
        // Ocultamos el splash inmediatamente sin animación
        splashScreen.style.display = 'none';
        // Mostramos el menú directamente
        mainContent.style.opacity = '1';
        // Pausamos el video por seguridad
        if (video) video.pause();

    } else {

        // --- CASO B: PRIMERA VEZ QUE ENTRA ---
        // Escuchamos el click para iniciar la experiencia
        splashScreen.addEventListener('click', function() {
            
            // A. Guardamos en la memoria del navegador que "Ya lo vio"
            sessionStorage.setItem('introVisto', 'true');
            
            // B. Desvanecer el Splash Screen
            splashScreen.style.opacity = '0';
            
            // C. Hacer visible el Contenido Principal
            mainContent.style.opacity = '1';

            // D. Esperar la animación (1 segundo) para quitarlo del todo
            setTimeout(function() {
                splashScreen.style.display = 'none';
                if (video) video.pause();
            }, 1000); 
            
        });
    }

});