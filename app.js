import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDhlCjxx0FeYOqZPbZiHD9BTYmTsl0PVCQ",
    authDomain: "suivi-ventes.firebaseapp.com",
    projectId: "suivi-ventes",
    storageBucket: "suivi-ventes.firebasestorage.app",
    messagingSenderId: "272523591744",
    appId: "1:272523591744:web:8f1ca8fbdfa2858f711fa5"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_PLATFORMS = ['Vinted', 'Etsy', 'Direct', 'LeBonCoin', 'Autre'];
const VALID_PAYMENTS  = ['Carte Bancaire', 'PayPal', 'Espèces'];

let currentUser = null;
let salesData = [];
let purchasesData = [];
let unsubSales = null;
let unsubPurchases = null;
let salesLoaded = false;
let purchasesLoaded = false;
let _toastTimer = null;

// --- UTILITAIRES ---

const escapeHTML = (str) => {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag]));
};

const safeMoneySum = (data, key) => {
    return data.reduce((acc, item) => {
        const amount = Math.round((Number(item[key]) || 0) * 100);
        return acc + amount;
    }, 0) / 100;
};

function formatDate(dateString) {
    if (!DATE_REGEX.test(dateString)) return escapeHTML(String(dateString));
    const [y, m, d] = dateString.split('-');
    const dateObj = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    if (isNaN(dateObj.getTime())) return escapeHTML(String(dateString));
    return dateObj.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function getTodayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showToast(msg, success = true) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.borderColor = success ? 'var(--success)' : 'var(--danger)';
    t.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
        t.classList.remove('show');
        _toastTimer = null;
    }, 3000);
}

function announceTableUpdate(message) {
    document.getElementById('tableAnnouncer').textContent = message;
}

function exportCSV(data, type, filename) {
    if (!data.length) { showToast('Aucune donnée à exporter', false); return; }

    const sanitizeCSV = (str) => {
        if (str === null || str === undefined) return '';
        let clean = String(str).replace(/"/g, '""');
        if (/^[=+\-@]/.test(clean)) clean = "'" + clean;
        return clean.replace(/[\n\r]/g, ' '); 
    };

    let csv;
    if (type === 'sales') {
        csv = 'Date,Produit,Plateforme,Montant Brut (EUR)\n' + data.map(s => `${s.date},"${sanitizeCSV(s.product)}","${sanitizeCSV(s.platform)}",${(Number(s.price) || 0).toFixed(2)}`).join('\n');
    } else {
        csv = 'Date,Description,Fournisseur,Moyen de paiement,Montant TTC (EUR)\n' + data.map(p => `${p.date},"${sanitizeCSV(p.description)}","${sanitizeCSV(p.supplier)}","${sanitizeCSV(p.paymentMethod)}",${(Number(p.amount) || 0).toFixed(2)}`).join('\n');
    }

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 150);
    showToast('Export CSV téléchargé !');
}

// --- AUTHENTIFICATION ET FIRESTORE ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        document.getElementById('skipLink').removeAttribute('tabindex');
        startListeningToData();
    } else {
        currentUser = null;
        salesData = []; purchasesData = [];
        salesLoaded = false; purchasesLoaded = false;
        if (unsubSales) { unsubSales(); unsubSales = null; }
        if (unsubPurchases) { unsubPurchases(); unsubPurchases = null; }
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('app-container').style.display = 'none';
        document.getElementById('skipLink').setAttribute('tabindex', '-1');
        document.getElementById('btnLogin').disabled = false;
        document.getElementById('btnLogin').textContent = 'Se connecter';
    }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnLogin');
    const errorText = document.getElementById('auth-error');
    btn.disabled = true; btn.textContent = 'Connexion...'; errorText.textContent = '';
    try {
        await signInWithEmailAndPassword(auth, document.getElementById('email').value.trim(), document.getElementById('password').value);
        showToast('Connecté !');
    } catch (err) {
        errorText.textContent = 'Identifiants incorrects.';
        btn.disabled = false; btn.textContent = 'Se connecter';
    }
});

document.getElementById('btnLogout').addEventListener('click', () => signOut(auth));

function startListeningToData() {
    if (!currentUser) return;
    [unsubSales, unsubPurchases].forEach(unsub => unsub && unsub());
    salesLoaded = false; purchasesLoaded = false;

    const createListener = (collectionName, stateSetter, loadFlagSetter) => {
        const q = query(collection(db, `users/${currentUser.uid}/${collectionName}`), orderBy('date', 'desc'));
        return onSnapshot(q, 
            (snap) => {
                stateSetter(snap.docs.map(d => ({ id: d.id, ...d.data() })));
                loadFlagSetter(true);
                if (salesLoaded && purchasesLoaded) refreshUI();
            },
            (error) => {
                console.error(`[Firestore] ${collectionName} error:`, error.code);
                loadFlagSetter(true);
                if (salesLoaded && purchasesLoaded) refreshUI();
                showToast(`Erreur de synchronisation : ${collectionName}`, false);
            }
        );
    };

    unsubSales = createListener('sales', data => salesData = data, flag => salesLoaded = flag);
    unsubPurchases = createListener('purchases', data => purchasesData = data, flag => purchasesLoaded = flag);
}

// --- GESTION DES FORMULAIRES ---

document.getElementById('salesForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!currentUser) return;
    const date = document.getElementById('saleDate').value;
    const product = document.getElementById('saleProduct').value.trim();
    const price = document.getElementById('salePrice').valueAsNumber;
    const platform = document.getElementById('salePlatform').value;

    if (!DATE_REGEX.test(date)) { showToast('Date invalide', false); return; }
    if (!product || product.length > 150) { showToast('Produit invalide', false); return; }
    if (!isFinite(price) || price <= 0 || price > 99999.99) { showToast('Montant invalide', false); return; }
    if (!VALID_PLATFORMS.includes(platform)) { showToast('Plateforme invalide', false); return; }

    const btn = this.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Enregistrement...';
    try {
        await addDoc(collection(db, `users/${currentUser.uid}/sales`), { date, product, price, platform, createdAt: serverTimestamp() });
        this.reset();
        document.getElementById('saleDate').value = getTodayISO();
        showToast('Vente enregistrée !');
    } catch (err) {
        showToast('Erreur de sauvegarde', false);
    } finally {
        btn.disabled = false; btn.textContent = 'Enregistrer la vente';
    }
});

document.getElementById('purchaseForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!currentUser) return;
    const date = document.getElementById('purchaseDate').value;
    const description = document.getElementById('purchaseDesc').value.trim();
    const amount = document.getElementById('purchaseAmount').valueAsNumber;
    const supplier = document.getElementById('purchaseSupplier').value.trim();
    const paymentMethod = document.getElementById('purchasePayment').value;

    if (!DATE_REGEX.test(date)) { showToast('Date invalide', false); return; }
    if (!description || description.length > 200) { showToast('Description invalide', false); return; }
    if (!isFinite(amount) || amount <= 0 || amount > 99999.99) { showToast('Montant invalide', false); return; }
    if (!supplier || supplier.length > 100) { showToast('Fournisseur invalide', false); return; }
    if (!VALID_PAYMENTS.includes(paymentMethod)) { showToast('Moyen de paiement invalide', false); return; }

    const btn = this.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Enregistrement...';
    try {
        await addDoc(collection(db, `users/${currentUser.uid}/purchases`), { date, description, amount, supplier, paymentMethod, createdAt: serverTimestamp() });
        this.reset();
        document.getElementById('purchaseDate').value = getTodayISO();
        showToast('Achat enregistré !');
    } catch (err) {
        showToast('Erreur de sauvegarde', false);
    } finally {
        btn.disabled = false; btn.textContent = "Enregistrer l'achat";
    }
});

// --- GESTION CENTRALISÉE DES SUPPRESSIONS ---

function setupDeleteHandler(containerId, collectionName, entityName) {
    document.getElementById(containerId).addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.btn-delete');
        if (deleteBtn && currentUser) {
            const id = deleteBtn.getAttribute('data-id');
            if (confirm(`Supprimer ${entityName} ?`)) {
                try {
                    await deleteDoc(doc(db, `users/${currentUser.uid}/${collectionName}`, id));
                    showToast(`${entityName} supprimé(e)`);
                    const container = document.getElementById(containerId);
                    container.setAttribute('tabindex', '-1');
                    container.focus(); 
                } catch (err) {
                    console.error(`[Firestore] Delete error:`, err.code);
                    showToast('Erreur : suppression impossible', false);
                }
            }
        }
    });
}

setupDeleteHandler('salesTableContainer', 'sales', 'cette vente');
setupDeleteHandler('purchasesTableContainer', 'purchases', 'cet achat');

// --- EXPORTS CSV ---

document.getElementById('btnExportSales').addEventListener('click', () => {
    const filter = document.getElementById('monthFilter').value;
    const data = filter ? salesData.filter(s => s.date?.startsWith(filter)) : [...salesData];
    exportCSV(data, 'sales', `StudioJade_Ventes_${filter || 'complet'}.csv`);
});

document.getElementById('btnExportPurchases').addEventListener('click', () => {
    const filter = document.getElementById('monthFilter').value;
    const data = filter ? purchasesData.filter(p => p.date?.startsWith(filter)) : [...purchasesData];
    exportCSV(data, 'purchases', `StudioJade_Achats_${filter || 'complet'}.csv`);
});

// --- LOGIQUE UI DÉCOUPÉE ET SÉCURISÉE ---

function updateMonthFilterOptions() {
    const sel = document.getElementById('monthFilter');
    const savedVal = sel.value;
    const allDates = [...salesData.map(s => s.date), ...purchasesData.map(p => p.date)].filter(d => typeof d === 'string' && d.length >= 7);
    const months = Array.from(new Set(allDates.map(d => d.substring(0, 7)))).sort().reverse();
    
    // Remplacement total du dernier innerHTML par la méthode pure DOM
    sel.replaceChildren();
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = "Tout l'historique";
    sel.appendChild(defaultOpt);

    months.forEach(m => {
        const [y, mo] = m.split('-');
        if (y && mo) {
            const name = new Date(parseInt(y, 10), parseInt(mo, 10) - 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            sel.appendChild(opt);
        }
    });
    if (savedVal && months.includes(savedVal)) sel.value = savedVal;
}

function updateDashboardStats(displaySales, displayPurchases, effectiveFilter, selOptions) {
    const rev = safeMoneySum(displaySales, 'price');
    const exp = safeMoneySum(displayPurchases, 'amount');
    const profit = (Math.round(rev * 100) - Math.round(exp * 100)) / 100;

    document.getElementById('totalRevenue').textContent = rev.toFixed(2) + "€";
    document.getElementById('totalPurchases').textContent = "- " + exp.toFixed(2) + "€";
    document.getElementById('netProfit').textContent = profit.toFixed(2) + "€";
    document.getElementById('totalCount').textContent = displaySales.length;

    const countLabelTarget = document.getElementById('totalCount').previousElementSibling;
    if (countLabelTarget) {
        countLabelTarget.textContent = effectiveFilter ? "Ventes (Période)" : "Ventes (Total)";
    }

    const labelURSSAF = effectiveFilter ? `Montant URSSAF à déclarer pour ${selOptions}` : "Chiffre d'Affaires total généré";
    document.getElementById('urssafLabel').textContent = labelURSSAF;
    document.getElementById('urssafAmount').textContent = rev.toFixed(2) + "€";
}

function createTableDOM(headers, rowBuilderFunction, dataArray, emptyMessage) {
    const container = document.createElement('div');
    if (!dataArray.length) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.textContent = emptyMessage;
        container.appendChild(emptyDiv);
        return container;
    }

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    
    headers.forEach(h => {
        const th = document.createElement('th');
        th.setAttribute('scope', 'col');
        if (h === 'Actions') {
            const span = document.createElement('span');
            span.className = 'sr-only';
            span.textContent = 'Actions';
            th.appendChild(span);
        } else {
            th.textContent = h;
        }
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    dataArray.forEach(item => {
        const tr = document.createElement('tr');
        rowBuilderFunction(item, tr);
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
    return container;
}

function buildSalesRow(s, tr) {
    const tdDate = document.createElement('td'); tdDate.textContent = formatDate(s.date);
    const tdProd = document.createElement('td'); tdProd.textContent = s.product;
    
    const tdPlat = document.createElement('td'); 
    const spanPlat = document.createElement('span'); 
    spanPlat.className = 'tag'; 
    spanPlat.textContent = s.platform;
    tdPlat.appendChild(spanPlat);

    const tdPrice = document.createElement('td'); 
    tdPrice.className = 'price-tag positive';
    tdPrice.textContent = `+${(Number(s.price) || 0).toFixed(2)}€`;

    const tdAction = document.createElement('td'); 
    tdAction.className = 'text-right';
    const btn = document.createElement('button'); 
    btn.type = 'button'; 
    btn.className = 'btn-delete';
    btn.setAttribute('data-id', s.id);
    btn.setAttribute('aria-label', `Supprimer la vente : ${s.product}`);
    btn.textContent = '×';
    tdAction.appendChild(btn);

    tr.append(tdDate, tdProd, tdPlat, tdPrice, tdAction);
}

function buildPurchasesRow(p, tr) {
    const tdDate = document.createElement('td'); tdDate.textContent = formatDate(p.date);
    const tdDesc = document.createElement('td'); tdDesc.textContent = p.description;
    
    const tdSup = document.createElement('td'); 
    const spanSup = document.createElement('span'); 
    spanSup.className = 'tag'; 
    spanSup.textContent = p.supplier;
    tdSup.appendChild(spanSup);

    const tdPrice = document.createElement('td'); 
    tdPrice.className = 'price-tag negative';
    tdPrice.textContent = `-${(Number(p.amount) || 0).toFixed(2)}€`;

    const tdAction = document.createElement('td'); 
    tdAction.className = 'text-right';
    const btn = document.createElement('button'); 
    btn.type = 'button'; 
    btn.className = 'btn-delete';
    btn.setAttribute('data-id', p.id);
    btn.setAttribute('aria-label', `Supprimer l'achat : ${p.description}`);
    btn.textContent = '×';
    tdAction.appendChild(btn);

    tr.append(tdDate, tdDesc, tdSup, tdPrice, tdAction);
}

function renderTables(displaySales, displayPurchases) {
    const tSales = document.getElementById('salesTableContainer');
    const tPurchases = document.getElementById('purchasesTableContainer');

    tSales.replaceChildren();
    tPurchases.replaceChildren();

    const salesDOM = createTableDOM(
        ['Date', 'Produit', 'Plateforme', 'Prix', 'Actions'],
        buildSalesRow,
        displaySales,
        'Aucune vente à afficher.'
    );

    const purchasesDOM = createTableDOM(
        ['Date', 'Matériel', 'Fournisseur', 'Prix', 'Actions'],
        buildPurchasesRow,
        displayPurchases,
        'Aucun achat enregistré.'
    );

    tSales.appendChild(salesDOM);
    tPurchases.appendChild(purchasesDOM);
    announceTableUpdate(`${displaySales.length} ventes et ${displayPurchases.length} achats affichés.`);
}

function refreshUI() {
    updateMonthFilterOptions();
    
    const sel = document.getElementById('monthFilter');
    const effectiveFilter = sel.value;
    
    const displaySales = effectiveFilter ? salesData.filter(s => s.date?.startsWith(effectiveFilter)) : [...salesData];
    const displayPurchases = effectiveFilter ? purchasesData.filter(p => p.date?.startsWith(effectiveFilter)) : [...purchasesData];

    updateDashboardStats(displaySales, displayPurchases, effectiveFilter, sel.options[sel.selectedIndex]?.text);
    renderTables(displaySales, displayPurchases);
}

// --- INITIALISATION ---

document.getElementById('saleDate').value = getTodayISO();
document.getElementById('purchaseDate').value = getTodayISO();
document.getElementById('monthFilter').addEventListener('change', refreshUI);
