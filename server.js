const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Estado global simple para partidas activas
let activeRooms = {}; 

io.on('connection', (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);

    // Evento principal: Crear o unirse a sala rápida
    socket.on('createOrJoinRoom', (data) => {
        const chosenClass = data?.playerClass || 'grower';
        
        let roomId = null;
        
        // Buscar sala existente con espacio (<2 jugadores) y no iniciada
        for (let id in activeRooms) {
            if (activeRooms[id].players.length < 2 && !activeRooms[id].started) {
                roomId = id;
                break;
            }
        }

        if (!roomId) {
            // Crear nueva sala si no hay disponibles
            roomId = Math.random().toString(36).substring(7);
            activeRooms[roomId] = {
                players: [],
                started: false,
                seed: Math.floor(Math.random() * 1000000) // Seed única para mapa determinista
            };
        }

        socket.join(roomId);
        const room = activeRooms[roomId];
        
        // Añadir jugador si no existe ya (evitar duplicados por reconexión)
        if (!room.players.find(p => p.socketId === socket.id)) {
            room.players.push({
                socketId: socket.id,
                name: `Jugador-${room.players.length + 1}`,
                lives: 3,
                finishedTime: null,
                playerClass: chosenClass // Guardamos la clase elegida
            });
        }

        // Emitir estado actualizado a todos en la sala
        io.to(roomId).emit('roomStateUpdate', {
            roomId: roomId,
            players: room.players.map(p => ({ 
                name: p.name, 
                lives: p.lives,
                class: p.playerClass 
            }))
        });

        // Si hay 2 jugadores, iniciar automáticamente tras delay corto
        if (room.players.length === 2 && !room.started) {
            setTimeout(() => {
                startGameInRoom(roomId);
            }, 2000); 
        }
    });

    // Evento cuando un jugador cruza la meta
    socket.on('playerFinished', (data) => {
        const rooms = Object.keys(socket.rooms);
        const gameId = rooms.filter(r => r !== socket.id)[0]; 
        
        if (!gameId || !activeRooms[gameId]) return;

        const room = activeRooms[gameId];
        const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
        
        if (playerIndex === -1) return;

        // Registrar tiempo de finalización
        room.players[playerIndex].finishedTime = data.timeTaken;

        checkGameOver(gameId);
    });

    function startGameInRoom(roomId) {
        const room = activeRooms[roomId];
        if (!room || room.started) return;

        room.started = true;
        
        // Enviar señal de inicio con la SEED compartida
        io.to(roomId).emit('startRound', {
            seed: room.seed,
            message: "¡Prepárense!"
        });
    }

    function checkGameOver(roomId) {
        const room = activeRooms[roomId];
        if (!room) return;

        const [p1, p2] = room.players;
        
        // Caso: Ambos terminaron
        if (p1.finishedTime !== null && p2.finishedTime !== null) {
            determineWinnerAndReset(roomId);
        } 
    }

    function determineWinnerAndReset(roomId) {
        const room = activeRooms[roomId];
        const [p1, p2] = room.players;

        let winnerIdx = -1;
        let loserIdx = -1;

        if (p1.finishedTime < p2.finishedTime) {
            winnerIdx = 0;
            loserIdx = 1;
        } else if (p2.finishedTime < p1.finishedTime) {
            winnerIdx = 1;
            loserIdx = 0;
        } else {
            // Empate técnico
            winnerIdx = 0; 
            loserIdx = 1;
        }

        // Aplicar penalización al perdedor
        room.players[loserIdx].lives -= 1;

        // Notificar resultado a los clientes
        io.to(roomId).emit('roundResult', {
            winnerName: room.players[winnerIdx].name,
            loserName: room.players[loserIdx].name,
            p1Lives: room.players[0].lives,
            p2Lives: room.players[1].lives,
            gameOver: room.players.some(p => p.lives <= 0)
        });

        // Resetear tiempos para siguiente ronda si nadie ha perdido todas las vidas
        if (!room.players.some(p => p.lives <= 0)) {
            room.players.forEach(p => p.finishedTime = null);
            room.started = false; 
            
            // Auto-reinicio tras 5 segundos
            setTimeout(() => {
                if(activeRooms[roomId]) startGameInRoom(roomId);
            }, 5000);
        } else {
            // Fin de la partida completa
            io.to(roomId).emit('matchOver', {
                winner: room.players[winnerIdx].name
            });
            delete activeRooms[roomId]; 
        }
    }

    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Block Breaking Battles corriendo en http://localhost:${PORT}`);
});
