const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname + '/public'));

const DB = __dirname + '/db.json';
if (!fs.existsSync(DB)) {
  fs.writeFileSync(DB, '{"users":[],"services":[],"orders":[],"categories":[],"reports":[],"revenus":{"total":0,"commissions":0,"urgences":0,"parrainages":0,"abonnements":0,"boosts":0,"publicites":0},"conversations":[],"messages":[],"publicites":[],"stories":[],"devis":[]}');
}

const read = () => JSON.parse(fs.readFileSync(DB));
const write = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));

// ==================== FIREBASE (NOTIFICATIONS PUSH) ====================
const admin = require('firebase-admin');
let fcmReady = false;
try {
  const serviceAccount = require('./firebase-key.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  fcmReady = true;
  console.log('✅ Firebase prêt');
} catch (e) {
  console.log('⚠️ Firebase non configuré (firebase-key.json manquant)');
}

async function sendPush(userId, title, body, data = {}) {
  if (!fcmReady) return;
  const db = read();
  const user = db.users.find(u => u.id === userId);
  if (!user?.fcmToken) return;
  try {
    await admin.messaging().send({
      token: user.fcmToken,
      notification: { title, body },
      data,
      android: { priority: 'high' },
    });
    console.log(`🔔 Push: ${user.prenom} - ${title}`);
  } catch (e) { console.error('Push error:', e.message); }
}

// ==================== CONFIG MOBILE MONEY CAMEROUN ====================
const MOMO_CONFIG = {
    mode: 'sandbox',
    sandboxUrl: 'https://sandbox.momodeveloper.mtn.com',
    productionUrl: 'https://ericssonbasicapi2.map.mtn.com',
    subscriptionKey: '8e6c06c7f80d425285f2a22bb13a7b43',
    apiUser: '94f9351e-2501-408e-b0ce-b3bc137836e5', 
    apiKey: 'a463e082-8e2a-44fa-8361-f5a974739039',
    votreNumeroMoMo: '237650105255',
};

const MOMO_BASE_URL = MOMO_CONFIG.mode === 'production' ? MOMO_CONFIG.productionUrl : MOMO_CONFIG.sandboxUrl;
const MOMO_ENV = MOMO_CONFIG.mode === 'production' ? 'production' : 'sandbox';

async function getMomoToken() {
    const auth = Buffer.from(`${MOMO_CONFIG.apiUser}:${MOMO_CONFIG.apiKey}`).toString('base64');
    const response = await axios.post(`${MOMO_BASE_URL}/collection/token/`, {}, {
        headers: { 'Authorization': `Basic ${auth}`, 'Ocp-Apim-Subscription-Key': MOMO_CONFIG.subscriptionKey }
    });
    return response.data.access_token;
}

async function requestMomoPayment(token, montant, telephoneClient, referenceId) {
    await axios.post(`${MOMO_BASE_URL}/collection/v1_0/requesttopay`, {
        amount: String(montant), currency: 'XAF', externalId: referenceId,
        payer: { partyIdType: 'MSISDN', partyId: String(telephoneClient) },
        payerMessage: 'Paiement ServiLink', payeeNote: 'Frais de service ServiLink',
    }, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Reference-Id': referenceId, 'X-Target-Environment': MOMO_ENV, 'Ocp-Apim-Subscription-Key': MOMO_CONFIG.subscriptionKey, 'Content-Type': 'application/json' }
    });
}

async function checkMomoStatus(token, referenceId) {
    const response = await axios.get(`${MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceId}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Ocp-Apim-Subscription-Key': MOMO_CONFIG.subscriptionKey, 'X-Target-Environment': MOMO_ENV }
    });
    return response.data.status;
}

// ==================== VARIABLES GLOBALES SOCKET ====================
global.onlineUsers = new Map();
global.io = io;

// ==================== SOCKET.IO - CHAT (avec audio) ====================
io.on('connection', (socket) => {
  console.log(`🔌 Nouvelle connexion socket: ${socket.id}`);
  socket.on('register-user', (userId) => { global.onlineUsers.set(userId, socket.id); console.log(`✅ Utilisateur ${userId} en ligne`); });
  socket.on('send-message', (data) => {
    try {
      const { conversationId, expediteurId, destinataireId, contenu, commandeId, type, audioUrl } = data;
      const db = read();
      let conversation = null;
      if (conversationId) conversation = db.conversations?.find(c => c.id === conversationId);
      if (!conversation && commandeId) conversation = db.conversations?.find(c => c.commande_id === commandeId);
      if (!conversation) {
        conversation = { id: 'conv_' + Date.now() + '_' + expediteurId, client_id: expediteurId, prestataire_id: destinataireId, commande_id: commandeId || null, date_creation: new Date().toISOString(), dernier_message: type === 'audio' ? '🎤 Message vocal' : (contenu || ''), dernier_message_date: new Date().toISOString(), non_lus_client: 0, non_lus_prestataire: 0 };
        if (!db.conversations) db.conversations = [];
        db.conversations.push(conversation);
      }
      const message = { id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2,6), conversation_id: conversation.id, expediteur_id: expediteurId, destinataire_id: destinataireId, contenu: contenu || '', type: type || 'text', audioUrl: audioUrl || null, lu: false, date_envoi: new Date().toISOString(), piece_jointe_url: null };
      if (!db.messages) db.messages = [];
      db.messages.push(message);
      const idx = db.conversations.findIndex(c => c.id === conversation.id);
      if (expediteurId === conversation.client_id) db.conversations[idx].non_lus_prestataire = (db.conversations[idx].non_lus_prestataire || 0) + 1;
      else db.conversations[idx].non_lus_client = (db.conversations[idx].non_lus_client || 0) + 1;
      db.conversations[idx].dernier_message = type === 'audio' ? '🎤 Message vocal' : contenu;
      db.conversations[idx].dernier_message_date = message.date_envoi;
      write(db);
      const destinataireSocketId = global.onlineUsers.get(destinataireId);
      if (destinataireSocketId) {
        const interlocuteur = db.users.find(u => u.id === expediteurId);
        io.to(destinataireSocketId).emit('receive-message', { ...message, conversation_id: conversation.id, interlocuteur: { id: interlocuteur?.id, nom: interlocuteur?.nom, prenom: interlocuteur?.prenom, nomComplet: interlocuteur ? `${interlocuteur.prenom} ${interlocuteur.nom}` : 'Utilisateur' } });
      }
      socket.emit('message-sent', { success: true, message, conversation: db.conversations[idx] });
    } catch (error) { console.error('Erreur envoi message:', error); socket.emit('message-error', { error: error.message }); }
  });
  socket.on('mark-as-read', (data) => {
    try {
      const { conversationId, userId } = data; const db = read();
      if (db.messages) { for (let i = 0; i < db.messages.length; i++) { if (db.messages[i].conversation_id === conversationId && db.messages[i].destinataire_id === userId && !db.messages[i].lu) db.messages[i].lu = true; } }
      if (db.conversations) { const idx = db.conversations.findIndex(c => c.id === conversationId); if (idx !== -1) { if (db.conversations[idx].client_id === userId) db.conversations[idx].non_lus_client = 0; else db.conversations[idx].non_lus_prestataire = 0; } }
      write(db); socket.emit('messages-read', { conversationId });
    } catch (error) { console.error('Erreur mark-as-read:', error); }
  });
  socket.on('typing', (data) => { const { destinataireId, isTyping, expediteurNom } = data; const destSocket = global.onlineUsers.get(destinataireId); if (destSocket) io.to(destSocket).emit('user-typing', { isTyping, expediteurNom }); });
  socket.on('disconnect', () => { for (let [userId, socketId] of global.onlineUsers.entries()) { if (socketId === socket.id) { global.onlineUsers.delete(userId); break; } } });
});

// ==================== ROUTES API ====================

app.get('/api/status', (req, res) => res.json({ status: 'online', compatible2G: true, compatible3G: true, compatible4G: true }));
app.get('/', (req, res) => res.json({ message: '🚀 Serveur ServiLink en ligne !' }));

// ==================== INSCRIPTION (avec fcmToken) ====================
app.post('/api/users/register', (req, res) => {
  const db = read();
  if (db.users.find(u => u.email === req.body.email)) return res.status(400).json({ message: 'Email déjà utilisé' });
  if (db.users.find(u => u.telephone === req.body.telephone)) return res.status(400).json({ message: 'Numéro déjà utilisé' });
  const codeParrainage = 'SL' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const isPrestataire = (req.body.role === 'prestataire');
  if (isPrestataire && (!req.body.identite || !req.body.identite.videoIdentite)) return res.status(400).json({ success: false, message: 'Vidéo d\'identité obligatoire.' });
  if (isPrestataire && (!req.body.certifications || !req.body.certifications.videoDiplome)) return res.status(400).json({ success: false, message: 'Vidéo de diplôme obligatoire.' });
  const user = { 
    id: Date.now().toString(), nom: req.body.nom, prenom: req.body.prenom, email: req.body.email, telephone: req.body.telephone, password: req.body.password, role: req.body.role || 'client', sexe: req.body.sexe || 'Homme', bio: '', adresse: { quartier: '', ville: '' }, verified: false, fcmToken: req.body.fcmToken || '',
    identite: isPrestataire ? { typePiece: (req.body.identite || {}).typePiece || 'cni', numeroPiece: (req.body.identite || {}).numeroPiece || '', nomComplet: (req.body.identite || {}).nomComplet || '', dateNaissance: (req.body.identite || {}).dateNaissance || '', dateExpiration: (req.body.identite || {}).dateExpiration || '', lieuDelivrance: (req.body.identite || {}).lieuDelivrance || '', videoIdentite: (req.body.identite || {}).videoIdentite || '', photoRecto: (req.body.identite || {}).photoRecto || '', photoVerso: (req.body.identite || {}).photoVerso || '', statutVerification: 'en_attente', dateSoumission: new Date().toISOString(), commentaireAdmin: '' } : null,
    certifications: isPrestataire ? [{ id: 'cert_' + Date.now(), typeDiplome: (req.body.certifications || {}).typeDiplome || '', intitule: (req.body.certifications || {}).intitule || '', etablissement: (req.body.certifications || {}).etablissement || '', anneeObtention: (req.body.certifications || {}).anneeObtention || '', mention: (req.body.certifications || {}).mention || '', videoDiplome: (req.body.certifications || {}).videoDiplome || '', photoDiplome: (req.body.certifications || {}).photoDiplome || '', statutVerification: 'en_attente', dateSoumission: new Date().toISOString(), commentaireAdmin: '' }] : [],
    reportCount: 0, blocked: false, trustScore: 0, totalDette: 0, codeParrainage, pointsFidelite: 0, codeParrainageUtilise: req.body.codeParrainage || '', cautionPayee: isPrestataire ? false : true, visible: isPrestataire ? false : true, commandesReussies: 0, modeEspecesAutorise: false, badgeVerifie: false, premium: null, messageVerification: 'Vérification en cours.', createdAt: new Date().toISOString()
  };
  if (req.body.codeParrainage && req.body.codeParrainage !== '') {
    const parrain = db.users.find(u => u.codeParrainage === req.body.codeParrainage);
    if (parrain) { parrain.pointsFidelite = (parrain.pointsFidelite || 0) + 100; db.revenus = db.revenus || { total: 0, commissions: 0, urgences: 0, parrainages: 0, abonnements: 0, boosts: 0, publicites: 0 }; db.revenus.parrainages = (db.revenus.parrainages || 0) + 500; db.revenus.total = (db.revenus.total || 0) + 500; }
  }
  db.users.push(user); write(db);
  res.status(201).json({ success: true, id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role, codeParrainage: user.codeParrainage });
});

// ==================== ADMIN VÉRIFICATIONS ====================
app.put('/api/admin/verification-identite/:userId', (req, res) => {
  const db = read(); const user = db.users.find(u => u.id === req.params.userId);
  if (!user || !user.identite) return res.status(404).json({ success: false, message: 'Non trouvé' });
  const { statut, commentaire } = req.body;
  if (!['approuve', 'rejete'].includes(statut)) return res.status(400).json({ success: false, message: 'Statut invalide' });
  user.identite.statutVerification = statut; user.identite.commentaireAdmin = commentaire || ''; user.identite.dateVerification = new Date().toISOString();
  if (statut === 'approuve') { user.verified = true; user.badgeVerifie = true; if (user.role === 'client') user.visible = true; if (user.role === 'prestataire' && user.certifications?.[0]?.statutVerification === 'approuve') { user.visible = true; user.messageVerification = '✅ Vérifié !'; } }
  else { user.verified = false; user.badgeVerifie = false; user.messageVerification = '❌ Rejeté : ' + (commentaire || 'Non conforme'); }
  write(db); res.json({ success: true, user });
});

app.put('/api/admin/verification-diplome/:userId', (req, res) => {
  const db = read(); const user = db.users.find(u => u.id === req.params.userId);
  if (!user || user.role !== 'prestataire') return res.status(404).json({ success: false, message: 'Non trouvé' });
  const { statut, commentaire } = req.body;
  if (!['approuve', 'rejete'].includes(statut)) return res.status(400).json({ success: false, message: 'Statut invalide' });
  if (!user.certifications || !user.certifications[0]) return res.status(404).json({ success: false, message: 'Aucune certification' });
  user.certifications[0].statutVerification = statut; user.certifications[0].commentaireAdmin = commentaire || '';
  if (user.identite?.statutVerification === 'approuve' && statut === 'approuve') { user.visible = true; user.badgeVerifie = true; }
  else if (statut === 'rejete') user.messageVerification = '❌ Diplôme rejeté';
  write(db); res.json({ success: true, user });
});

app.get('/api/admin/verifications-en-attente', (req, res) => {
  const db = read();
  const identites = db.users.filter(u => u.identite?.statutVerification === 'en_attente').map(u => ({ id: u.id, nom: u.nom, prenom: u.prenom, email: u.email, telephone: u.telephone, role: u.role, type: 'identite', piece: u.identite.typePiece, video: u.identite.videoIdentite ? '✅' : '❌', dateSoumission: u.identite.dateSoumission }));
  const diplomes = db.users.filter(u => u.role === 'prestataire' && u.certifications?.[0]?.statutVerification === 'en_attente').map(u => ({ id: u.id, nom: u.nom, prenom: u.prenom, email: u.email, telephone: u.telephone, type: 'diplome', typeDiplome: u.certifications[0].typeDiplome, intitule: u.certifications[0].intitule, video: u.certifications[0].videoDiplome ? '✅' : '❌', dateSoumission: u.certifications[0].dateSoumission }));
  res.json({ success: true, total: identites.length + diplomes.length, identites, diplomes });
});

// ==================== LOGIN ====================
app.post('/api/users/login', (req, res) => {
  const db = read(); let user;
  if (req.body.email) user = db.users.find(u => u.email === req.body.email && u.password === req.body.password);
  else if (req.body.telephone) user = db.users.find(u => u.telephone === req.body.telephone && u.password === req.body.password);
  if (!user) return res.status(401).json({ message: 'Identifiants incorrects' });
  if (user.blocked) return res.status(403).json({ message: 'Compte bloqué' });
  if (user.identite?.statutVerification === 'rejete') return res.status(403).json({ message: 'Identité rejetée' });
  res.json(user);
});

// ==================== SERVICES & COMMANDES ====================
app.post('/api/services', (req, res) => {
  const db = read(); const p = db.users.find(u => u.id === req.body.prestataireId);
  if (p?.blocked) return res.status(403).json({ message: 'Bloqué' });
  if (p && !p.visible) return res.status(403).json({ message: 'Non visible' });
  const s = { id: Date.now().toString(), ...req.body, devise: 'FCFA', estDisponible: true, stock: parseInt(req.body.stock) || 0, stockInitial: parseInt(req.body.stock) || 0, ville: p?.adresse?.ville || '', createdAt: new Date().toISOString() };
  db.services.push(s); write(db); res.status(201).json(s);
});

app.put('/api/services/:id/stock', (req, res) => {
  const db = read();
  const service = db.services.find(s => s.id === req.params.id);
  if (!service) return res.status(404).json({ success: false });
  service.stock = parseInt(req.body.stock) || 0;
  service.estDisponible = service.stock > 0;
  write(db);
  res.json({ success: true, service });
});

app.post('/api/orders', (req, res) => {
  const db = read();
  const service = db.services.find(s => s.id === req.body.serviceId);
  if (service && service.stock !== undefined && service.stock < (parseInt(req.body.quantite) || 1)) {
    return res.status(400).json({ message: 'Stock insuffisant' });
  }
  if (service) { service.stock -= (parseInt(req.body.quantite) || 1); if (service.stock <= 0) service.estDisponible = false; }
  const prixTotal = parseFloat(req.body.prixTotal) || 0;
  const estUrgent = req.body.estUrgent === true;
  const commission = estUrgent ? prixTotal * 0.12 : prixTotal * 0.10;
  const order = { id: Date.now().toString(), ...req.body, statut: 'en_attente', commission, commissionPayee: false, adresseVisible: false, adresseReelle: req.body.adresseLivraison, estUrgent, momoReferenceId: null, momoStatus: null, commissionPrelevee: 0, paiementLibere: false, createdAt: new Date().toISOString() };
  db.orders.push(order); write(db);
  sendPush(req.body.prestataireId, '📦 Nouvelle commande !', `${req.body.serviceNom || 'Un client'} a commandé`);
  res.status(201).json({ ...order, adresseLivraison: 'Visible après paiement' });
});

// ==================== PAIEMENT MOBILE MONEY ====================
app.post('/api/orders/pay-mobile', async (req, res) => {
    try {
        const db = read(); const order = db.orders.find(o => o.id === req.body.orderId);
        if (!order) return res.status(404).json({ success: false, message: 'Commande non trouvée' });
        const prixTotal = parseFloat(order.prixTotal) || 0;
        const estUrgent = order.estUrgent === true;
        const pourcentageCommission = estUrgent ? 0.12 : 0.10;
        const votreCommission = Math.round(prixTotal * pourcentageCommission);
        const telephoneClient = req.body.telephone || req.body.numeroClient;
        if (telephoneClient) {
            const referenceId = uuidv4(); const token = await getMomoToken();
            await requestMomoPayment(token, votreCommission, telephoneClient, referenceId);
            order.momoReferenceId = referenceId; order.momoStatus = 'PENDING'; order.commissionPrelevee = votreCommission; write(db);
            res.json({ success: true, message: `Paiement de ${votreCommission} XAF initié.`, referenceId, orderId: order.id, montantCommission: votreCommission, pourcentage: pourcentageCommission * 100, destinataire: MOMO_CONFIG.votreNumeroMoMo, statut: 'PENDING' });
        } else {
            order.statut = 'payee'; order.adresseVisible = true; order.commissionPayee = true; order.commissionPrelevee = votreCommission; write(db);
            res.json({ success: true, adresse: order.adresseReelle, message: 'Paiement confirmé' });
        }
    } catch (error) { res.status(500).json({ success: false, message: 'Erreur paiement', erreur: error.message }); }
});

app.get('/api/orders/momo-status/:referenceId', async (req, res) => {
    try {
        const token = await getMomoToken(); const status = await checkMomoStatus(token, req.params.referenceId);
        if (status === 'SUCCESSFUL') {
            const db = read(); const order = db.orders.find(o => o.momoReferenceId === req.params.referenceId);
            if (order) { order.statut = 'payee'; order.adresseVisible = true; order.commissionPayee = true; order.momoStatus = 'SUCCESSFUL'; db.revenus.commissions = (db.revenus.commissions || 0) + (order.commissionPrelevee || 0); db.revenus.total = (db.revenus.total || 0) + (order.commissionPrelevee || 0); write(db); }
        }
        res.json({ success: true, referenceId: req.params.referenceId, statut: status });
    } catch (error) { res.status(500).json({ success: false, message: 'Erreur' }); }
});

// ==================== PREUVES ====================
app.post('/api/orders/:id/preuve-prestataire', (req, res) => {
  const db = read();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Commande non trouvée' });
  order.preuvePrestataire = req.body.preuveUrl;
  order.statut = 'preuve_prestataire_fournie';
  write(db);
  console.log(`📸 Preuve prestataire reçue pour commande ${order.id}`);
  res.json({ success: true, message: 'Preuve prestataire envoyée' });
});

app.post('/api/orders/:id/preuve-client', (req, res) => {
  const db = read();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Commande non trouvée' });
  order.preuveClient = req.body.preuveUrl;
  order.statut = 'preuves_fournies';
  write(db);
  console.log(`📸 Preuve client reçue pour commande ${order.id}`);
  res.json({ success: true, message: 'Preuve client envoyée' });
});

// ==================== FACTURE ====================
app.get('/api/orders/:id/facture', (req, res) => {
  const db = read();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false });
  const client = db.users.find(u => u.id === order.clientId);
  const prestataire = db.users.find(u => u.id === order.prestataireId);
  const facture = {
    id: 'FAC-' + order.id.substring(0, 8),
    date: order.createdAt,
    client: { nom: order.clientNom, telephone: client?.telephone },
    prestataire: { nom: order.prestataireNom || '', telephone: prestataire?.telephone },
    service: order.serviceNom,
    montant: order.prixTotal,
    commission: order.commission,
    modePaiement: order.modePaiement,
    statut: order.statut,
  };
  res.json({ success: true, facture });
});

// ==================== PREMIUM, BOOST & PUBLICITÉ AVEC MOMO ====================
app.post('/api/premium/subscribe', async (req, res) => {
  const db = read(); const user = db.users.find(u => u.id === req.body.userId);
  if (!user || user.role !== 'prestataire') return res.status(400).json({ success: false, message: 'Non autorisé' });
  const plan = req.body.plan || 'mensuel';
  const prix = plan === 'mensuel' ? 2000 : plan === 'trimestriel' ? 5000 : 15000;
  const dureeJours = plan === 'mensuel' ? 30 : plan === 'trimestriel' ? 90 : 365;
  const telephone = req.body.telephone || user.telephone;
  try {
    const referenceId = uuidv4(); const token = await getMomoToken();
    await requestMomoPayment(token, prix, telephone, referenceId);
    user.premium = { actif: true, plan, dateDebut: new Date().toISOString(), dateFin: new Date(Date.now() + dureeJours * 86400000).toISOString(), boostVisibilite: true, momoReferenceId: referenceId, momoStatus: 'PENDING' };
    db.revenus.abonnements = (db.revenus.abonnements || 0) + prix; db.revenus.total = (db.revenus.total || 0) + prix; write(db);
    res.json({ success: true, message: `Paiement de ${prix} FCFA initié. Vérifiez votre téléphone.`, prix, dateFin: user.premium.dateFin });
  } catch (error) { res.status(500).json({ success: false, message: 'Erreur paiement' }); }
});

app.get('/api/premium/status/:userId', (req, res) => {
  const db = read(); const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ success: false });
  const premium = user.premium || { actif: false };
  if (premium.actif && new Date(premium.dateFin) < new Date()) { premium.actif = false; user.premium = premium; write(db); }
  res.json({ success: true, premium });
});

app.post('/api/boost', async (req, res) => {
  const db = read(); const service = db.services.find(s => s.id === req.body.serviceId);
  if (!service) return res.status(404).json({ success: false, message: 'Service non trouvé' });
  const user = db.users.find(u => u.id === req.body.userId);
  const dureeHeures = req.body.duree || 24;
  const prix = dureeHeures <= 24 ? 500 : dureeHeures <= 72 ? 1200 : 2500;
  const telephone = req.body.telephone || user?.telephone || MOMO_CONFIG.votreNumeroMoMo;
  try {
    const referenceId = uuidv4(); const token = await getMomoToken();
    await requestMomoPayment(token, prix, telephone, referenceId);
    service.boost = { actif: true, dateDebut: new Date().toISOString(), dateFin: new Date(Date.now() + dureeHeures * 3600000).toISOString() };
    db.revenus.boosts = (db.revenus.boosts || 0) + prix; db.revenus.total = (db.revenus.total || 0) + prix; write(db);
    res.json({ success: true, message: `Boost de ${prix} FCFA initié. Vérifiez votre téléphone.`, prix });
  } catch (error) { res.status(500).json({ success: false, message: 'Erreur paiement' }); }
});

app.get('/api/services/boosted', (req, res) => {
  const db = read(); const now = new Date();
  res.json({ success: true, services: db.services.filter(s => s.boost?.actif && new Date(s.boost.dateFin) > now) });
});

app.post('/api/publicites', async (req, res) => {
  const db = read();
  const prix = (req.body.dureeJours || 7) * 1000;
  const telephone = req.body.telephone || MOMO_CONFIG.votreNumeroMoMo;
  try {
    const referenceId = uuidv4(); const token = await getMomoToken();
    await requestMomoPayment(token, prix, telephone, referenceId);
    const pub = { id: 'pub_' + Date.now(), titre: req.body.titre || '', description: req.body.description || '', lien: req.body.lien || '', annonceurNom: req.body.annonceurNom || '', dateDebut: new Date().toISOString(), dateFin: new Date(Date.now() + (req.body.dureeJours || 7) * 86400000).toISOString(), prix, active: true };
    if (!db.publicites) db.publicites = [];
    db.publicites.push(pub);
    db.revenus.publicites = (db.revenus.publicites || 0) + prix; db.revenus.total = (db.revenus.total || 0) + prix; write(db);
    res.status(201).json({ success: true, message: `Pub créée ! Paiement de ${prix} FCFA initié.`, pub });
  } catch (error) { res.status(500).json({ success: false, message: 'Erreur paiement' }); }
});

app.get('/api/publicites/actives', (req, res) => {
  const db = read(); const now = new Date();
  res.json({ success: true, publicites: (db.publicites || []).filter(p => p.active && new Date(p.dateFin) > now) });
});

// ==================== PAIEMENT SÉQUESTRE ====================
app.put('/api/orders/:id/valider', (req, res) => {
  const db = read();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Commande non trouvée' });
  order.statut = 'termine';
  order.paiementLibere = true;
  write(db);
  sendPush(order.clientId, '✅ Commande terminée', `Votre commande "${order.serviceNom}" est terminée`);
  sendPush(order.prestataireId, '💰 Paiement libéré', `Le paiement pour "${order.serviceNom}" a été libéré`);
  console.log(`✅ Paiement libéré pour la commande ${order.id}`);
  res.json({ success: true, message: 'Paiement libéré au prestataire', order });
});

// ==================== STORIES/REELS ====================
app.post('/api/stories', (req, res) => {
  const db = read();
  const story = {
    id: 'st_' + Date.now(),
    prestataireId: req.body.prestataireId,
    prestataireNom: req.body.prestataireNom || '',
    videoUrl: req.body.videoUrl || '',
    photoUrl: req.body.photoUrl || '',
    description: req.body.description || '',
    dateCreation: new Date().toISOString(),
    dateExpiration: new Date(Date.now() + 86400000).toISOString(),
  };
  if (!db.stories) db.stories = [];
  db.stories.push(story);
  write(db);
  res.status(201).json({ success: true, story });
});

app.get('/api/stories/actives', (req, res) => {
  const db = read();
  const now = new Date();
  const stories = (db.stories || []).filter(s => new Date(s.dateExpiration) > now);
  const enriched = stories.map(s => {
    const p = db.users.find(u => u.id === s.prestataireId);
    return { ...s, prestataireNom: p ? `${p.prenom} ${p.nom}` : s.prestataireNom };
  });
  res.json({ success: true, stories: enriched });
});

// ==================== DEVIS ====================
app.post('/api/devis', (req, res) => {
  const db = read();
  const devis = { id: 'dev_' + Date.now(), clientId: req.body.clientId, description: req.body.description, photos: req.body.photos || [], budgetMin: req.body.budgetMin || 0, budgetMax: req.body.budgetMax || 0, ville: req.body.ville || '', categorie: req.body.categorie || '', statut: 'ouvert', propositions: [], dateCreation: new Date().toISOString() };
  if (!db.devis) db.devis = []; db.devis.push(devis); write(db);
  res.status(201).json({ success: true, devis });
});

app.get('/api/devis', (req, res) => { const db = read(); res.json({ success: true, devis: (db.devis || []).filter(d => d.statut === 'ouvert') }); });

app.post('/api/devis/:id/proposer', (req, res) => {
  const db = read(); const devis = db.devis.find(d => d.id === req.params.id);
  if (!devis) return res.status(404).json({ success: false });
  devis.propositions.push({ prestataireId: req.body.prestataireId, prestataireNom: req.body.prestataireNom, prix: req.body.prix, message: req.body.message || '', date: new Date().toISOString() }); write(db);
  res.json({ success: true, devis });
});

// ==================== DASHBOARD PRESTATAIRE ====================
app.get('/api/prestataire/stats/:userId', (req, res) => {
  const db = read();
  const orders = db.orders.filter(o => o.prestataireId === req.params.userId);
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    totalCommandes: orders.length,
    commandesJour: orders.filter(o => o.createdAt?.startsWith(today)).length,
    commandesTerminees: orders.filter(o => o.statut === 'termine').length,
    revenusTotal: orders.reduce((s, o) => s + (o.prixTotal || 0), 0),
    commissionsTotal: orders.reduce((s, o) => s + (o.commission || 0), 0),
    noteMoyenne: 0,
  };
  res.json({ success: true, stats });
});

// ==================== TOP PRESTATAIRES ====================
app.get('/api/top-prestataires', (req, res) => {
  const db = read();
  const top = db.users.filter(u => u.role === 'prestataire' && u.commandesReussies >= 5).sort((a, b) => b.trustScore - a.trustScore).slice(0, 10).map(u => ({ id: u.id, nom: u.nom, prenom: u.prenom, trustScore: u.trustScore, commandesReussies: u.commandesReussies }));
  res.json({ success: true, top });
});

// ==================== LITIGES & TRANSACTIONS ====================
app.post('/api/litiges', (req, res) => {
  const db = read(); const order = db.orders.find(o => o.id === req.body.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Commande non trouvée' });
  const litige = { id: 'lit_' + Date.now(), orderId: req.body.orderId, clientId: req.body.clientId, prestataireId: order.prestataireId, serviceNom: order.serviceNom || '', montant: order.prixTotal || 0, motif: req.body.motif || '', description: req.body.description || '', statut: 'en_attente', dateCreation: new Date().toISOString(), dateResolution: null, commentaireAdmin: '' };
  if (!db.litiges) db.litiges = [];
  db.litiges.push(litige);
  order.litigeId = litige.id; order.statutLitige = 'en_attente'; write(db);
  res.status(201).json({ success: true, litige });
});

app.get('/api/litiges', (req, res) => {
  const db = read();
  const enriched = (db.litiges || []).map(l => {
    const client = db.users.find(u => u.id === l.clientId);
    const prestataire = db.users.find(u => u.id === l.prestataireId);
    return { ...l, clientNom: client ? `${client.prenom} ${client.nom}` : 'Inconnu', prestataireNom: prestataire ? `${prestataire.prenom} ${prestataire.nom}` : 'Inconnu' };
  });
  res.json({ success: true, litiges: enriched });
});

app.put('/api/litiges/:id', (req, res) => {
  const db = read(); const litige = db.litiges.find(l => l.id === req.params.id);
  if (!litige) return res.status(404).json({ success: false });
  litige.statut = req.body.statut; litige.commentaireAdmin = req.body.commentaire || ''; litige.dateResolution = new Date().toISOString();
  const order = db.orders.find(o => o.id === litige.orderId);
  if (order && req.body.statut === 'rembourse') {
    order.statut = 'rembourse';
    const prestataire = db.users.find(u => u.id === litige.prestataireId);
    if (prestataire) { prestataire.trustScore = (prestataire.trustScore || 0) - 30; prestataire.totalDette = (prestataire.totalDette || 0) + litige.montant; if (prestataire.trustScore < -50) prestataire.blocked = true; }
  }
  write(db); res.json({ success: true, litige });
});

app.get('/api/admin/transactions', (req, res) => {
  const db = read();
  const commissions = db.orders.filter(o => o.commissionPayee).map(o => ({ type: 'Commission', montant: o.commissionPrelevee || o.commission || 0, date: o.createdAt, details: `Commande: ${o.serviceNom || ''}` }));
  const parrainages = db.users.filter(u => u.codeParrainageUtilise).map(u => ({ type: 'Parrainage', montant: 500, date: u.createdAt, details: `Filleul: ${u.prenom} ${u.nom}` }));
  const abonnements = db.users.filter(u => u.premium?.actif).map(u => ({ type: 'Abonnement Premium', montant: u.premium.plan === 'mensuel' ? 2000 : u.premium.plan === 'trimestriel' ? 5000 : 15000, date: u.premium.dateDebut, details: `${u.prenom} ${u.nom}` }));
  const pubs = (db.publicites || []).map(p => ({ type: 'Publicité', montant: p.prix || 0, date: p.dateDebut, details: p.titre || '' }));
  const remboursements = (db.litiges || []).filter(l => l.statut === 'rembourse').map(l => ({ type: 'Remboursement', montant: -(l.montant || 0), date: l.dateResolution, details: l.motif || '' }));
  const transactions = [...commissions, ...parrainages, ...abonnements, ...pubs, ...remboursements].sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ success: true, total: transactions.reduce((s, t) => s + t.montant, 0), transactions });
});

// ==================== GETTERS ====================
app.get('/api/revenus', (req, res) => { const db = read(); db.revenus = db.revenus || { total: 0 }; res.json(db.revenus); });
app.get('/api/stats', (req, res) => { const db = read(); res.json({ totalUsers: db.users.length, totalOrders: db.orders.length, totalRevenus: db.orders.reduce((s, o) => s + (o.commission || 0), 0), commandesJour: db.orders.filter(o => o.createdAt?.startsWith(new Date().toISOString().split('T')[0])).length, identitesEnAttente: db.users.filter(u => u.identite?.statutVerification === 'en_attente').length, diplomesEnAttente: db.users.filter(u => u.certifications?.[0]?.statutVerification === 'en_attente').length }); });
app.get('/api/categories', (req, res) => res.json(read().categories));
app.get('/api/services', (req, res) => res.json(read().services));
app.get('/api/orders', (req, res) => res.json(read().orders));
app.get('/api/services/ville/:ville', (req, res) => { const db = read(); res.json(db.services.filter(s => s.ville?.toLowerCase() === req.params.ville.toLowerCase())); });
app.get('/api/users/prestataires', (req, res) => res.json(read().users.filter(u => u.role === 'prestataire' && !u.blocked && u.visible)));
app.get('/api/paiement/config', (req, res) => res.json({ success: true, mode: MOMO_CONFIG.mode, destinataire: MOMO_CONFIG.votreNumeroMoMo, devise: 'XAF', pays: 'Cameroun', pourcentageCommissionNormal: 10, pourcentageCommissionUrgent: 12, parrainage: 500 }));
app.get('/api/referral/:id', (req, res) => { const db = read(); const user = db.users.find(u => u.id === req.params.id); res.json({ code: user?.codeParrainage, points: user?.pointsFidelite || 0 }); });

// ==================== ENVOI CODE SMS ====================
app.post('/api/send-code', (req, res) => {
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  console.log(`📱 Code SMS pour ${req.body.telephone}: ${code}`);
  res.json({ success: true, code: code });
});

// ==================== DÉMARRAGE ====================
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Serveur ServiLink démarré sur le port ${PORT}`);
  console.log(`✅ WebSocket Socket.io prêt`);
  console.log(`🔔 Notifications push ${fcmReady ? 'ACTIVÉES' : 'non configurées'}`);
  console.log(`💳 Paiement Mobile Money Cameroun INTÉGRÉ`);
  console.log(`📸 Système de preuves (client + prestataire) ACTIVÉ`);
  console.log(`📄 Factures ACTIVÉES`);
  console.log(`🔒 Paiement séquestre ACTIVÉ`);
  console.log(`📱 Stories/Reels ACTIVÉES`);
  console.log(`📝 Devis ACTIVÉS`);
  console.log(`📊 Dashboard prestataire ACTIVÉ`);
  console.log(`🏆 Top Prestataires ACTIVÉ`);
  console.log(`🆔 Vérification identité ACTIVÉE`);
  console.log(`🎓 Certification diplômes ACTIVÉE`);
  console.log(`📦 Gestion de stock ACTIVÉE`);
  console.log(`⭐ Premium, 📢 Boost, 📺 Publicités avec MoMo ACTIVÉS`);
  console.log(`⚠️ Litiges et Transactions ACTIVÉS`);
  console.log(`📡 Mode: ${MOMO_CONFIG.mode}`);
  console.log(`💰 Commission: 10% / 12% | Parrainage: 500 FCFA`);
  console.log(`💵 Argent vers: ${MOMO_CONFIG.votreNumeroMoMo}`);
  console.log(`📡 API: http://localhost:${PORT}`);
});