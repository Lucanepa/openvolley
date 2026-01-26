function openMenu(type) {
    const menuId = `menu-${type}`;
    const menuEl = document.getElementById(menuId);

    // Activate menu container
    menuEl.classList.add('active');

    // Animate container opacity
    anime({
        targets: menuEl,
        opacity: [0, 1],
        duration: 300,
        easing: 'easeOutQuad'
    });

    // Animate items
    anime({
        targets: `#${menuId} .menu-item`,
        translateY: [20, 0],
        opacity: [0, 1],
        delay: anime.stagger(100, { start: 100 }),
        duration: 800,
        easing: 'easeOutElastic(1, .6)'
    });
}

function closeMenu(type) {
    const menuId = `menu-${type}`;
    const menuEl = document.getElementById(menuId);

    // Animate container out
    anime({
        targets: menuEl,
        opacity: [1, 0],
        duration: 300,
        easing: 'easeInQuad',
        complete: function (anim) {
            menuEl.classList.remove('active');
        }
    });
}

// Add escape key listener to close menus
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const activeMenu = document.querySelector('.sub-menu.active');
        if (activeMenu) {
            const type = activeMenu.id.replace('menu-', '');
            closeMenu(type);
        }
    }
});

// Change ball image based on hover
function changeBall(type) {
    const ballImg = document.getElementById('hero-ball');
    if (type === 'beach') {
        ballImg.src = 'ball_beach.png';
    } else if (type === 'readvolley') {
        // Try ball_readvolley.png first, fallback to readvolley.png if not found
        ballImg.src = 'ball_readvolley.png';
        ballImg.onerror = function() {
            this.src = 'readvolley.png';
            this.onerror = null; // Prevent infinite loop
        };
    } else {
        ballImg.src = 'ball.png';
    }
}
