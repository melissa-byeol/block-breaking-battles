// --- CONFIGURACIÓN Y ESTADO GLOBAL ---
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const socket = io();

// Elementos DOM
const menuScreen = document.getElementById('menu-screen');
const btnPlay = document.getElementById('btn-play');
const statusMsg = document.getElementById('status-message');
const uiTimer = document.getElementById('race-timer');
const uiLives = document.getElementById('my-lives');
const centerMsg = document.getElementById('center-msg');
const classListContainer = document.getElementById('class-list');
const myClassBadge = document.getElementById('my-class-badge');

// Constantes de Física
const GRAVITY = 0.4;
const FRICTION_AIR = 0.98;
const BOUNCE_DAMPING = 0.7; // Pérdida de energía al rebotar en paredes

// Definición de Clases
const BALL_CLASSES = {
    grower: { 
        name: 'Grower', 
        color: '#00FF00', 
        desc: 'Crece 1.5px al tocar paredes',
        textColor: '#000'
    },
    speedy: { 
        name: 'Speedy', 
        color: '#FF2E2E', 
        desc: '+2 Max Speed al tocar paredes',
        textColor: '#fff'
    },
    slammy: { 
        name: 'Slammy', 
        color: '#7F768D', 
        desc: 'Acumula daño. 10% chance Dash Explosivo',
        textColor: '#fff'
    },
    splitter: { 
        name: 'Splitter', 
        color: '#FF0080', 
        desc: '5% chance Clon (+1% por fallo)',
        textColor: '#fff'
    }
};

// Estado del Jugador Local
let myPlayer = {
    x: 0, y: 0,
    vx: 0, vy: 0,
    radius: 15,
    baseRadius: 15,
    color: '#ffffff',
    type: 'grower', // Default
    maxSpeedBase: 8,
    currentMaxSpeed: 8,
    
    // Mecánicas Específicas
    slamCharge: 0,
    splitFailStreak: 0,
    
    isPlaying: false,
    startTime: 0,
    endTime: 0,
    lives: 3
};

// Entidades del Mundo
let blocks = [];
let goalZone = { x: 0, y: 0, w: 0, h: 0 };
let particles = []; 
let clones = []; 

// Controles
const keys = {
    ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
    w: false, s: false, a: false, d: false
};

let animationId;
let lastTimestamp = 0;
let selectedClassKey = 'grower'; // Para el menú

// --- INICIALIZACIÓN DE EVENTOS ---

window.addEventListener('resize', resizeCanvas);
document.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
document.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

// Generar Menú de Clases Dinámico
function setupMenu() {
    classListContainer.innerHTML = '';
    Object.keys(BALL_CLASSES).forEach(key => {
        const cls = BALL_CLASSES[key];
        const card = document.createElement('div');
        card.className = 'class-card';
        card.style.borderColor = cls.color;
        card.dataset.class = key;
        
        card.innerHTML = `
            <span class="class-name" style="color:${cls.color}">${cls.name}</span>
            <span class="class-desc">${cls.desc}</span>
        `;
        
        card.onclick = () => selectClass(key, card);
        classListContainer.appendChild(card);
    });
    
    // Seleccionar primera por defecto visualmente
    if(classListContainer.firstChild) {
        classListContainer.firstChild.classList.add('selected');
    }
}

function selectClass(key, element) {
    selectedClassKey = key;
    // Quitar selección anterior
    Array.from(classListContainer.children).forEach(c => c.classList.remove('selected'));
    // Añadir selección actual
    element.classList.add('selected');
}

setupMenu();

btnPlay.addEventListener('click', () => {
    statusMsg.textContent = `Buscando rival como ${BALL_CLASSES[selectedClassKey].name}...`;
    socket.emit('createOrJoinRoom', { playerClass: selectedClassKey });
});

// --- LISTENERS DEL SERVIDOR ---

socket.on('roomStateUpdate', (data) => {
    updateUI(data.players);
    if (data.players.length >= 2) {
        statusMsg.textContent = "¡Rival encontrado! Preparándose...";
    } else {
        statusMsg.textContent = "Esperando segundo jugador...";
    }
});

socket.on('startRound', (data) => {
    hideMenu();
    generateMap(data.seed);
    resetPlayerPosition(selectedClassKey);
    
    myPlayer.isPlaying = true;
    myPlayer.startTime = performance.now();
    lastTimestamp = myPlayer.startTime;
    
    if (animationId) cancelAnimationFrame(animationId);
    gameLoop(myPlayer.startTime);
    
    showCenterMessage("¡CORRE!", "#ffeaa7", 1000);
});

socket.on('roundResult', (data) => {
    myPlayer.isPlaying = false;
    cancelAnimationFrame(animationId);
    
    // Identificación simple basada en orden de llegada asumido o ID local
    // En este prototipo, usamos una variable global set on connect si fuera necesario,
    // pero simplificaremos asumiendo que sabemos nuestras vidas locales hasta que el server confirme.
    // Actualizamos vidas visuales basadas en lo que el server dice sobre "mi" slot.
    // Nota crítica: El server manda p1Lives y p2Lives. Necesitamos saber cuál somos.
    // Hack rápido: Guardamos nuestro index al unirnos? No es perfecto sin más info.
    // Asumiremos que el cliente rastrea sus propias vidas localmente y el server solo confirma ganador/perdedor.
    // Para mantenerlo simple: Si gané, mis vidas siguen igual. Si perdí, resto 1.
    
    const iWon = data.winnerName === getMyLocalName();
    if (!iWon) {
        myPlayer.lives--;
    }
    updateHearts(myPlayer.lives);

    if (data.gameOver) {
        showCenterMessage(iWon ? "¡GANASTE LA PARTIDA!" : "PERDISTE TODO", 
                          iWon ? "#2ecc71" : "#e74c3c");
        setTimeout(() => location.reload(), 4000);
    } else {
        showCenterMessage(iWon ? "¡RONDA GANADA!" : "RONDA PERDIDA", iWon ? "#2ecc71" : "#e74c3c");
        setTimeout(clearCenterMessage, 2000);
    }
});

// --- FUNCIONES DE JUEGO (FÍSICA & RENDER) ---

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function generateMap(seed) {
    // PRNG Simple (Mulberry32) para garantizar mismo mapa con misma seed
    let t = seed ^ 0x6D2B79F5;
    const random = () => {
        let res = Math.imul(t ^ t >>> 15, t | 1);
        res ^= res + Math.imul(res ^ res >>> 7, res | 61);
        return ((res ^ res >>> 14) >>> 0) / 4294967296;
    };

    blocks = [];
    mapWidth = canvas.width;
    mapHeight = canvas.height;

    goalZone = { x: mapWidth/2 - 100, y: 0, w: 200, h: 60 };

    const numBlocks = 150; 
    
    for (let i = 0; i < numBlocks; i++) {
        let bx = random() * (mapWidth - 40);
        let by = random() * (mapHeight - 100) + 50;
        let bw = random() * 60 + 20;
        let bh = random() * 60 + 20;

        blocks.push({
            x: bx, y: by, w: bw, h: bh,
            color: `hsl(${random()*360}, 70%, 50%)`,
            destroyed: false
        });
    }
    clones = [];
    particles = [];
}

function resetPlayerPosition(playerType) {
    myPlayer.type = playerType;
    myPlayer.color = BALL_CLASSES[playerType].color;
    myPlayer.baseRadius = 15;
    myPlayer.radius = 15;
    myPlayer.currentMaxSpeed = myPlayer.maxSpeedBase;
    myPlayer.slamCharge = 0;
    myPlayer.splitFailStreak = 0;
    myPlayer.lives = 3; // Reset vidas locales al empezar partida nueva (si recarga página)

    // Badge UI
    myClassBadge.textContent = BALL_CLASSES[playerType].name.toUpperCase();
    myClassBadge.style.backgroundColor = BALL_CLASSES[playerType].color;
    myClassBadge.style.color = BALL_CLASSES[playerType].textColor;

    myPlayer.x = canvas.width / 2;
    myPlayer.y = canvas.height - 40;
    myPlayer.vx = 0;
    myPlayer.vy = 0;
}

function updatePhysics(deltaTime) {
    if (!myPlayer.isPlaying) return;

    // Input Handling
    let ax = 0;
    let ay = 0;
    const accel = 0.8;
    
    if (keys.arrowup || keys.w) ay -= accel * 1.5; // Fuerte contra gravedad
    if (keys.arrowdown || keys.s) ay += accel;
    if (keys.arrowleft || keys.a) ax -= accel;
    if (keys.arrowright || keys.d) ax += accel;

    // Gravedad
    myPlayer.vy += GRAVITY;

    // Aplicar aceleración input
    myPlayer.vx += ax;
    myPlayer.vy += ay;

    // Fricción aire
    myPlayer.vx *= FRICTION_AIR;
    myPlayer.vy *= FRICTION_AIR;

    // Limitar velocidad máxima
    const speedMag = Math.sqrt(myPlayer.vx**2 + myPlayer.vy**2);
    if (speedMag > myPlayer.currentMaxSpeed) {
        myPlayer.vx = (myPlayer.vx / speedMag) * myPlayer.currentMaxSpeed;
        myPlayer.vy = (myPlayer.vy / speedMag) * myPlayer.currentMaxSpeed;
    }

    // Movimiento
    myPlayer.x += myPlayer.vx;
    myPlayer.y += myPlayer.vy;

    handleWallCollisions();
    handleBlockCollisions();
    updateClones();
    updateParticles();
    checkGoal();
}

function handleWallCollisions() {
    let hitWall = false;

    // Izquierda/Derecha
    if (myPlayer.x < myPlayer.radius) {
        myPlayer.x = myPlayer.radius;
        myPlayer.vx *= -BOUNCE_DAMPING;
        hitWall = true;
    } else if (myPlayer.x > canvas.width - myPlayer.radius) {
        myPlayer.x = canvas.width - myPlayer.radius;
        myPlayer.vx *= -BOUNCE_DAMPING;
        hitWall = true;
    }

    // Arriba/Abajo
    if (myPlayer.y < myPlayer.radius) {
        myPlayer.y = myPlayer.radius;
        myPlayer.vy *= -BOUNCE_DAMPING;
        hitWall = true;
    } else if (myPlayer.y > canvas.height - myPlayer.radius) {
        myPlayer.y = canvas.height - myPlayer.radius;
        myPlayer.vy *= -BOUNCE_DAMPING;
        hitWall = true;
    }

    if (hitWall) applyWallMechanics();
}

function applyWallMechanics() {
    switch(myPlayer.type) {
        case 'grower':
            myPlayer.radius += 1.5;
            createParticleEffect(myPlayer.x, myPlayer.y, '#00FF00', 5);
            break;
        
        case 'speedy':
            myPlayer.currentMaxSpeed += 2;
            createParticleEffect(myPlayer.x, myPlayer.y, '#FF2E2E', 5);
            break;
            
        case 'slammy':
            myPlayer.slamCharge++;
            break;
            
        case 'splitter':
            break;
    }
}

function handleBlockCollisions() {
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.destroyed) continue;

        // Colisión Círculo vs Rectángulo precisa
        const closestX = Math.max(b.x, Math.min(myPlayer.x, b.x + b.w));
        const closestY = Math.max(b.y, Math.min(myPlayer.y, b.y + b.h));
        
        const dx = myPlayer.x - closestX;
        const dy = myPlayer.y - closestY;
        const distanceSquared = dx*dx + dy*dy;

        if (distanceSquared < myPlayer.radius * myPlayer.radius) {
            // Resolución penetración
            const dist = Math.sqrt(distanceSquared) || 0.1;
            const overlap = myPlayer.radius - dist;
            if (dist > 0) {
                myPlayer.x += (dx / dist) * overlap;
                myPlayer.y += (dy / dist) * overlap;
            }

            // Penalización de velocidad
            myPlayer.vx *= 0.8;
            myPlayer.vy *= 0.8;

            processBlockHit(b);
            b.destroyed = true;
            createParticleEffect(b.x + b.w/2, b.y + b.h/2, b.color, 10);
        }
    }
}

function processBlockHit(block) {
    switch(myPlayer.type) {
        case 'grower':
        case 'speedy':
            break;
            
        case 'slammy':
            if (Math.random() < 0.10) { // 10% chance
                executeSlamDash(block);
            }
            break;
            
        case 'splitter':
            attemptCloneSpawn();
            break;
    }
}

function executeSlamDash(centerBlock) {
    const blastRadius = 50 + (myPlayer.slamCharge * 5);
    const cx = centerBlock.x + centerBlock.w/2;
    const cy = centerBlock.y + centerBlock.h/2;

    blocks.forEach(b => {
        if (b.destroyed) return;
        const bcx = b.x + b.w/2;
        const bcy = b.y + b.h/2;
        const d = Math.hypot(cx - bcx, cy - bcy);
        if (d < blastRadius) {
            b.destroyed = true;
            createParticleEffect(bcx, bcy, '#FFFFFF', 3);
        }
    });

    createParticleEffect(cx, cy, '#7F768D', 20);
    myPlayer.slamCharge = 0;
}

function attemptCloneSpawn() {
    const chance = 0.05 + (myPlayer.splitFailStreak * 0.01);
    if (Math.random() < chance) {
        myPlayer.splitFailStreak = 0;
        spawnClone();
    } else {
        myPlayer.splitFailStreak++;
    }
}

function spawnClone() {
    clones.push({
        x: myPlayer.x,
        y: myPlayer.y,
        vx: (Math.random() - 0.5) * 10,
        vy: (Math.random() - 0.5) * 10,
        radius: myPlayer.radius * 0.8,
        life: 300
    });
}

function updateClones() {
    for (let i = clones.length - 1; i >= 0; i--) {
        const c = clones[i];
        c.life--;
        c.vy += GRAVITY * 0.5;
        c.x += c.vx;
        c.y += c.vy;

        // Rebote paredes básicos
        if (c.x < c.radius || c.x > canvas.width - c.radius) c.vx *= -1;
        if (c.y < c.radius || c.y > canvas.height - c.radius) c.vy *= -1;

        // Colisión con bloques
        blocks.forEach(b => {
            if (b.destroyed) return;
            const closestX = Math.max(b.x, Math.min(c.x, b.x + b.w));
            const closestY = Math.max(b.y, Math.min(c.y, b.y + b.h));
            const dx = c.x - closestX;
            const dy = c.y - closestY;
            if (dx*dx + dy*dy < c.radius*c.radius) {
                b.destroyed = true;
                createParticleEffect(closestX, closestY, '#FF0080', 5);
            }
        });

        if (c.life <= 0) clones.splice(i, 1);
    }
}

function checkGoal() {
    if (myPlayer.y < goalZone.y + goalZone.h && 
        myPlayer.x > goalZone.x && 
        myPlayer.x < goalZone.x + goalZone.w) {
        finishRace();
    }
}

function finishRace() {
    myPlayer.isPlaying = false;
    myPlayer.endTime = performance.now();
    const timeTaken = (myPlayer.endTime - myPlayer.startTime) / 1000;
    drawFrame(); 
    socket.emit('playerFinished', { timeTaken: timeTaken });
    showCenterMessage("CRUZASTE LA META...", "#00cec9");
}

// --- EFECTOS VISUALES ---
function createParticleEffect(x, y, color, count) {
    for(let i=0; i<count; i++) {
        particles.push({
            x: x, y: y,
            vx: (Math.random() - 0.5) * 5,
            vy: (Math.random() - 0.5) * 5,
            life: 20 + Math.random() * 20,
            color: color
        });
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life--;
        if (p.life <= 0) particles.splice(i, 1);
    }
}

function drawFrame() {
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Meta
    ctx.fillStyle = 'rgba(46, 204, 113, 0.2)';
    ctx.fillRect(goalZone.x, goalZone.y, goalZone.w, goalZone.h);
    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 2;
    ctx.strokeRect(goalZone.x, goalZone.y, goalZone.w, goalZone.h);
    ctx.fillStyle = '#2ecc71';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText("META", goalZone.x + goalZone.w/2, goalZone.y + 30);

    // Bloques
    for (let b of blocks) {
        if (b.destroyed) continue;
        ctx.fillStyle = b.color;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.strokeRect(b.x, b.y, b.w, b.h);
    }

    // Partículas
    for (let p of particles) {
        ctx.globalAlpha = p.life / 40;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI*2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Clones
    for (let c of clones) {
        ctx.fillStyle = 'rgba(255, 0, 128, 0.6)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.radius, 0, Math.PI*2);
        ctx.fill();
    }

    // Jugador Principal
    ctx.beginPath();
    ctx.arc(myPlayer.x, myPlayer.y, myPlayer.radius, 0, Math.PI * 2);
    ctx.fillStyle = myPlayer.color;
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Indicadores de Estado
    if (myPlayer.type === 'slammy' && myPlayer.slamCharge > 0) {
        ctx.fillStyle = 'yellow';
        ctx.font = '12px Arial';
        ctx.fillText(`⚡${myPlayer.slamCharge}`, myPlayer.x, myPlayer.y - myPlayer.radius - 10);
    }
    
    if (myPlayer.type === 'splitter' && myPlayer.splitFailStreak > 0) {
        ctx.fillStyle = 'pink';
        ctx.font = '12px Arial';
        ctx.fillText(`+${myPlayer.splitFailStreak}%`, myPlayer.x, myPlayer.y - myPlayer.radius - 10);
    }
}

function updateTimerDisplay() {
    if (!myPlayer.isPlaying) return;
    const now = performance.now();
    const diff = (now - myPlayer.startTime) / 1000;
    const mins = Math.floor(diff / 60);
    const secs = Math.floor(diff % 60);
    const ms = Math.floor((diff % 1) * 100);
    uiTimer.textContent = `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
}

function gameLoop(timestamp) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    const deltaTime = timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    updatePhysics(deltaTime);
    drawFrame();
    updateTimerDisplay();

    if (myPlayer.isPlaying) {
        animationId = requestAnimationFrame(gameLoop);
    }
}

// --- UTILIDADES UI ---
function hideMenu() { menuScreen.classList.add('hidden'); }
function showCenterMessage(text, color, durationMs = 2000) {
    centerMsg.textContent = text;
    centerMsg.style.color = color;
    centerMsg.style.opacity = 1;
    if(durationMs) setTimeout(clearCenterMessage, durationMs);
}
function clearCenterMessage() { centerMsg.textContent = ""; centerMsg.style.opacity = 0; }
function updateUI(playersData) {
    // Solo para debug o sincronización inicial
}
function updateHearts(livesCount) {
    let hearts = '';
    for(let i=0; i<3; i++) hearts += i < livesCount ? '❤️' : '🖤';
    uiLives.textContent = hearts;
}
function getMyLocalName() {
    // Simulación simple. En producción usaríamos el ID del socket.
    return "Yo"; 
}

// Init
resizeCanvas();
updateHearts(3);
