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

const escapeHTML = (str) => {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag]));
};

// FIX LOGIQUE MÉTIER : Gestion parfaite des flottants (JS convertit en centimes avant calcul)
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
    if (isNaN(dateObj.getTime())) return escapeHTML(dateString);
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

// FIX SÉCURITÉ : Prévention DDE/Formula Injection et bugs de sauts de ligne
function exportCSV(data, type, filename) {
    if (!data.length) {
        showToast('Aucune donnée à exporter', false);
        return;
    }

    const sanitizeCSV = (str) => {
        if (str === null || str === undefined) return '';
        let clean = String(str).replace(/"/g, '""');
        if (/^[=+\-@]/.test(clean)) clean = "'" + clean;
        return clean.replace(/[\n\r]/g, ' '); 
    };

    let csv;
    if (type === 'sales') {
        csv = 'Date,Produit,Plateforme,Montant Brut (EUR)\n' +
            data.map(s =>
                `${s.date},"${sanitizeCSV(s.product)}","${sanitizeCSV(s.platform)}",${(Number(s.price) || 0).toFixed(2)}`
            ).join('\n');
    } else {
        csv = 'Date,Description,Fournisseur,Moyen de paiement,Montant TTC (EUR)\n' +
            data.map(p =>
                `${p.date},"${sanitizeCSV(p.description)}","${sanitizeCSV(p.supplier)}","${sanitizeCSV(p.paymentMethod)}",${(Number(p.amount) || 0).toFixed(2)}`
            ).join('\n');
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

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        document.getElementById('skipLink').removeAttribute('tabindex');
        startListeningToData();
    } else {
        currentUser = null;
        salesData = [];
        purchasesData = [];
        salesLoaded = false;
        purchasesLoaded = false;

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

    btn.disabled = true;
    btn.textContent = 'Connexion...';
    errorText.textContent = '';

    try {
        await signInWithEmailAndPassword(
            auth,
            document.getElementById('email').value.trim(),
            document.getElementById('password').value
        );
        showToast('Connecté !');
    } catch (err) {
        errorText.textContent = 'Identifiants incorrects.';
        btn.disabled = false;
        btn.textContent = 'Se connecter';
    }
});

document.getElementById('btnLogout').addEventListener('click', () => signOut(auth));

// FIX ARCHITECTURE : Factory Pattern pour supprimer la duplication onSnapshot
function startListeningToData() {
    if (!currentUser) return;

    [unsubSales, unsubPurchases].forEach(unsub => unsub && unsub());
    salesLoaded = false;
    purchasesLoaded = false;

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

document.getElementById('salesForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!currentUser) return;

    const date     = document.getElementById('saleDate').value;
    const product  = document.getElementById('saleProduct').value.trim();
    const price    = document.getElementById('salePrice').valueAsNumber;
    const platform = document.getElementById('salePlatform').value;

    if (!DATE_REGEX.test(date))                                { showToast('Date invalide', false); return; }
    if (!product || product.length > 150)                      { showToast('Produit invalide', false); return; }
    if (!isFinite(price) || price <= 0 || price > 99999.99)    { showToast('Montant invalide', false); return; }
    if (!VALID_PLATFORMS.includes(platform))                   { showToast('Plateforme invalide', false); return; }

    const btn = this.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Enregistrement...';

    try {
        await addDoc(collection(db, `users/${currentUser.uid}/sales`), {
            date, product, price, platform,
            createdAt: serverTimestamp()
        });
        this.reset();
        document.getElementById('saleDate').value = getTodayISO();
        showToast('Vente enregistrée !');
    } catch (err) {
        showToast('Erreur de sauvegarde', false);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enregistrer la vente';
    }
});

document.getElementById('purchaseForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!currentUser) return;

    const date          = document.getElementById('purchaseDate').value;
    const description   = document.getElementById('purchaseDesc').value.trim();
    const amount        = document.getElementById('purchaseAmount').valueAsNumber;
    const supplier      = document.getElementById('purchaseSupplier').value.trim();
    const paymentMethod = document.getElementById('purchasePayment').value;

    if (!DATE_REGEX.test(date))                                  { showToast('Date invalide', false); return; }
    if (!description || description.length > 200)                { showToast('Description invalide', false); return; }
    if (!isFinite(amount) || amount <= 0 || amount > 99999.99)   { showToast('Montant invalide', false); return; }
    if (!supplier || supplier.length > 100)                      { showToast('Fournisseur invalide', false); return; }
    if (!VALID_PAYMENTS.includes(paymentMethod))                 { showToast('Moyen de paiement invalide', false); return; }

    const btn = this.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Enregistrement...';

    try {
        await addDoc(collection(db, `users/${currentUser.uid}/purchases`), {
            date, description, amount, supplier, paymentMethod,
            createdAt: serverTimestamp()
        });
        this.reset();
        document.getElementById('purchaseDate').value = getTodayISO();
        showToast('Achat enregistré dans le registre !');
    } catch (err) {
        showToast('Erreur de sauvegarde', false);
    } finally {
        btn.disabled = false;
        btn.textContent = "Enregistrer l'achat";
    }
});

// FIX ACCESSIBILITÉ : Restauration du focus après suppression
document.getElementById('salesTableContainer').addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.btn-delete');
    if (deleteBtn && currentUser) {
        const id = deleteBtn.getAttribute('data-id');
        if (confirm('Supprimer cette vente ?')) {
            try {
                await deleteDoc(doc(db, `users/${currentUser.uid}/sales`, id));
                showToast('Vente supprimée');
                
                const container = document.getElementById('salesTableContainer');
                container.setAttribute('tabindex', '-1');
                container.focus(); 
            } catch (err) {
                console.error('[Firestore] Delete sale error:', err.code);
                showToast('Erreur : suppression impossible', false);
            }
        }
    }
});

// FIX ACCESSIBILITÉ : Restauration du focus après suppression
document.getElementById('purchasesTableContainer').addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.btn-delete');
    if (deleteBtn && currentUser) {
        const id = deleteBtn.getAttribute('data-id');
        if (confirm('Supprimer cet achat du registre ?')) {
            try {
                await deleteDoc(doc(db, `users/${currentUser.uid}/purchases`, id));
                showToast('Achat supprimé');
                
                const container = document.getElementById('purchasesTableContainer');
                container.setAttribute('tabindex', '-1');
                container.focus();
            } catch (err) {
                console.error('[Firestore] Delete purchase error:', err.code);
                showToast('Erreur : suppression impossible', false);
            }
        }
    }
});

document.getElementById('btnExportSales').addEventListener('click', () => {
    const sel = document.getElementById('monthFilter');
    const filter = sel.value;
    const data = filter ? salesData.filter(s => s.date?.startsWith(filter)) : [...salesData];
    const label = filter ? sel.options[sel.selectedIndex]?.text.replace(/\s/g, '-') : 'complet';
    exportCSV(data, 'sales', `StudioJade_Ventes_${label}.csv`);
});

document.getElementById('btnExportPurchases').addEventListener('click', () => {
    const sel = document.getElementById('monthFilter');
    const filter = sel.value;
    const data = filter ? purchasesData.filter(p => p.date?.startsWith(filter)) : [...purchasesData];
    const label = filter ? sel.options[sel.selectedIndex]?.text.replace(/\s/g, '-') : 'complet';
    exportCSV(data, 'purchases', `StudioJade_Achats_${label}.csv`);
});

function refreshUI() {
    const sel = document.getElementById('monthFilter');

    const allDates = [
        ...salesData.map(s => s.date),
        ...purchasesData.map(p => p.date)
    ].filter(d => typeof d === 'string' && d.length >= 7);

    const months = new Set(allDates.map(d => d.substring(0, 7)));
    const savedVal = sel.value;

    sel.innerHTML = "<option value=''>Tout l'historique</option>";
    Array.from(months).sort().reverse().forEach(m => {
        const [y, mo] = m.split('-');
        if (y && mo) {
            const name = new Date(parseInt(y, 10), parseInt(mo, 10) - 1)
                .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            sel.appendChild(opt);
        }
    });

    if (savedVal && Array.from(months).includes(savedVal)) sel.value = savedVal;

    // FIX MATHS : Utilisation de safeMoneySum pour éviter les erreurs de flottants JS
    const globalRev = safeMoneySum(salesData, 'price');
    const globalExp = safeMoneySum(purchasesData, 'amount');
    const globalProfit = (Math.round(globalRev * 100) - Math.round(globalExp * 100)) / 100;

    document.getElementById('totalRevenue').textContent = globalRev.toFixed(2) + "€";
    document.getElementById('totalPurchases').textContent = "- " + globalExp.toFixed(2) + "€";
    document.getElementById('netProfit').textContent = globalProfit.toFixed(2) + "€";
    document.getElementById('totalCount').textContent = salesData.length;

    const effectiveFilter = sel.value;

    const displaySales = effectiveFilter
        ? salesData.filter(s => s.date?.startsWith(effectiveFilter))
        : [...salesData];

    const displayPurchases = effectiveFilter
        ? purchasesData.filter(p => p.date?.startsWith(effectiveFilter))
        : [...purchasesData];

    // FIX MATHS : Idem ici pour l'URSSAF
    const filteredRev = safeMoneySum(displaySales, 'price');

    const labelURSSAF = effectiveFilter
        ? `Montant URSSAF à déclarer pour ${sel.options[sel.selectedIndex]?.text}`
        : "Chiffre d'Affaires total généré";

    document.getElementById('urssafLabel').textContent = labelURSSAF;
    document.getElementById('urssafAmount').textContent = filteredRev.toFixed(2) + "€";

    const tSales = document.getElementById('salesTableContainer');
    if (!displaySales.length) {
        tSales.innerHTML = `<div class="empty-state">Aucune vente à afficher.</div>`;
    } else {
        let html = `<table>
            <thead>
                <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Produit</th>
                    <th scope="col">Plateforme</th>
                    <th scope="col">Prix</th>
                    <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
            </thead>
            <tbody>`;

        displaySales.forEach(s => {
            const safeProduct = escapeHTML(s.product);
            const safePlatform = escapeHTML(s.platform);
            const safeId = escapeHTML(s.id);

            html += `<tr>
                <td>${formatDate(s.date)}</td>
                <td>${safeProduct}</td>
                <td><span class="tag">${safePlatform}</span></td>
                <td class="price-tag positive">+${(Number(s.price) || 0).toFixed(2)}€</td>
                <td class="text-right">
                    <button type="button" class="btn-delete" data-id="${safeId}" aria-label="Supprimer la vente : ${safeProduct}">×</button>
                </td>
            </tr>`;
        });

        tSales.innerHTML = html + '</tbody></table>';
    }

    const tPurchases = document.getElementById('purchasesTableContainer');
    if (!displayPurchases.length) {
        tPurchases.innerHTML = `<div class="empty-state">Aucun achat enregistré.</div>`;
    } else {
        let html = `<table>
            <thead>
                <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Matériel</th>
                    <th scope="col">Fournisseur</th>
                    <th scope="col">Prix</th>
                    <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
            </thead>
            <tbody>`;

        displayPurchases.forEach(p => {
            const safeDesc = escapeHTML(p.description);
            const safeSupplier = escapeHTML(p.supplier);
            const safeId = escapeHTML(p.id);

            html += `<tr>
                <td>${formatDate(p.date)}</td>
                <td>${safeDesc}</td>
                <td><span class="tag">${safeSupplier}</span></td>
                <td class="price-tag negative">-${(Number(p.amount) || 0).toFixed(2)}€</td>
                <td class="text-right">
                    <button type="button" class="btn-delete" data-id="${safeId}" aria-label="Supprimer l'achat : ${safeDesc}">×</button>
                </td>
            </tr>`;
        });

        tPurchases.innerHTML = html + '</tbody></table>';
    }

    announceTableUpdate(`${displaySales.length} ventes et ${displayPurchases.length} achats affichés.`);
}

document.getElementById('saleDate').value = getTodayISO();
document.getElementById('purchaseDate').value = getTodayISO();
document.getElementById('monthFilter').addEventListener('change', refreshUI);
