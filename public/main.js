import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc, query, where, orderBy, serverTimestamp, getDocs, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

console.log("Firebase App Initialized", app);

// DOM Elements
const authContainer = document.getElementById('auth-container');
const appContainer = document.getElementById('app-container');

// Init Standard Paragraphs
document.execCommand('defaultParagraphSeparator', false, 'div');

const authForm = document.getElementById('auth-form');
const authBtn = document.getElementById('auth-btn');
const authSwitchBtn = document.getElementById('auth-switch-btn');
const authSwitchText = document.getElementById('auth-switch-text');
const authError = document.getElementById('auth-error');
const userEmailDisplay = document.getElementById('user-email');
const logoutBtn = document.getElementById('logout-btn');

const loadingOverlay = document.getElementById('loading-overlay');

const notesListEl = document.getElementById('notes-list');
const createNoteBtn = document.getElementById('create-note-btn');
const editorView = document.getElementById('editor-view');
const emptyState = document.getElementById('empty-state');
const noteTitleInput = document.getElementById('note-title');
const noteContentInput = document.getElementById('note-content');
const saveStatus = document.getElementById('save-status');

// State
let isLoginMode = true;
let currentUser = null;
let notes = [];
let activeNoteId = null;
let notesUnsubscribe = null;
let saveTimeout = null;

// Optimization State
let lastSavedState = { id: null, title: null, content: null, titleAlign: null };
let isAcquiringLock = false;

// Auth Logic
function toggleAuthMode() {
    isLoginMode = !isLoginMode;
    if (isLoginMode) {
        authBtn.textContent = "Log In";
        authSwitchText.innerHTML = 'Don\'t have an account? <span id="auth-switch-btn">Sign Up</span>';
    } else {
        authBtn.textContent = "Sign Up";
        authSwitchText.innerHTML = 'Already have an account? <span id="auth-switch-btn">Log In</span>';
    }
    document.getElementById('auth-switch-btn').addEventListener('click', toggleAuthMode);
    authError.textContent = "";
}

authSwitchBtn.addEventListener('click', toggleAuthMode);

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    authError.textContent = "";

    try {
        if (isLoginMode) {
            await signInWithEmailAndPassword(auth, email, password);
        } else {
            await createUserWithEmailAndPassword(auth, email, password);
        }
    } catch (error) {
        authError.textContent = error.message.replace('Firebase: ', '');
    }
});

logoutBtn.addEventListener('click', () => {
    signOut(auth);
});

onAuthStateChanged(auth, (user) => {
    loadingOverlay.classList.add('fade-out'); // Hide loading screen
    currentUser = user;
    if (user) {
        authContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');
        userEmailDisplay.textContent = user.email;
        loadNotes();
    } else {
        authContainer.classList.remove('hidden');
        appContainer.classList.add('hidden');
        if (notesUnsubscribe) notesUnsubscribe();
        notes = [];
        activeNoteId = null;
        renderNotesList();
        showEmptyState();
    }
});

// Note Management Logic

// Note Management Logic

// Separate arrays for merging
let ownedNotes = [];
let sharedNotes = [];
let sharedNotesUnsubscribe = null;

function loadNotes() {
    if (!currentUser) return;
    
    // 1. Owned Notes
    const q1 = query(
        collection(db, "notes"),
        where("userId", "==", currentUser.uid)
    );

    notesUnsubscribe = onSnapshot(q1, (snapshot) => {
        ownedNotes = snapshot.docs.map(doc => ({ 
            id: doc.id, 
            ...doc.data(),
            hasPendingWrites: doc.metadata.hasPendingWrites 
        }));
        mergeAndRenderNotes();
    }, (error) => console.error("Owned Notes Error:", error));

    // 2. Shared Notes (where I am in collaborators)
    const q2 = query(
        collection(db, "notes"),
        where("collaborators", "array-contains", currentUser.uid)
    );

    sharedNotesUnsubscribe = onSnapshot(q2, (snapshot) => {
        sharedNotes = snapshot.docs.map(doc => ({ 
            id: doc.id, 
            ...doc.data(),
            hasPendingWrites: doc.metadata.hasPendingWrites 
        }));
        mergeAndRenderNotes();
    }, (error) => console.error("Shared Notes Error:", error));
}

function mergeAndRenderNotes() {
    // Merge and Deduplicate (just in case)
    const all = [...ownedNotes, ...sharedNotes];
    // Map to keep unique by ID
    const uniqueMap = new Map();
    all.forEach(n => uniqueMap.set(n.id, n));
    
    notes = Array.from(uniqueMap.values());
    
    // Sort descending by updated
    notes.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
    
    renderNotesList();

    // Active Note Validation
    if (activeNoteId) {
         const note = notes.find(n => n.id === activeNoteId);
         if (note) {
             // Sync Content Logic:
             // If locked by someone else -> Always show their latest changes (Read Only mode)
             // If I am not typing (saveTimeout is null) -> Show latest changes (Unlocks, or general updates)
             const isLockedByOther = note.lockedBy && note.lockedBy !== currentUser.uid;
             
             // Only update if not typing, AND if the change is not our own pending write
             if ((isLockedByOther || !saveTimeout) && !note.hasPendingWrites) {
                 if (noteTitleInput.innerHTML !== (note.title || "")) {
                     noteTitleInput.innerHTML = note.title || "";
                 }
                 if (noteContentInput.innerHTML !== (note.content || "")) {
                     noteContentInput.innerHTML = note.content || "";
                 }
                 // Also restore alignment if changed
                 if (note.titleAlign && noteTitleInput.style.textAlign !== note.titleAlign) {
                     noteTitleInput.style.textAlign = note.titleAlign;
                 }
                 
                 // SYNC OPTIMIZATION: Update our local tracker so we don't save back what we just received
                 lastSavedState = {
                     id: note.id,
                     title: note.title || "",
                     content: note.content || "",
                     titleAlign: note.titleAlign || 'left'
                 };

                 checkPlaceholder();
             }
             
             updateEditorLockState(note);
         } else {
             // If active note is gone from both lists
             showEmptyState();
         }
    }
}

// Note Actions

function renderNotesList() {
    notesListEl.innerHTML = '';
    notes.forEach(note => {
        const el = document.createElement('div');
        el.className = `note-item ${note.id === activeNoteId ? 'active' : ''}`;
        
        // Strip HTML for preview safely
        const tempDiv = document.createElement('div');
        // Use DOMParser to parse HTML content without executing scripts
        const parser = new DOMParser();
        const doc = parser.parseFromString(note.content || '', 'text/html');
        const plainText = doc.body.textContent || '';
        const previewText = plainText.substring(0, 30) + (plainText.length > 30 ? '...' : '');

        // Strip HTML for title too just in case it has tags
        const titleDoc = parser.parseFromString(note.title || '', 'text/html');
        const plainTitle = titleDoc.body.textContent || 'Untitled Note';

        // Helper to escape HTML for safe injection
        const escapeHtml = (str) => {
            return str
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        };

        el.innerHTML = `
            <div class="note-info">
                <h3>${escapeHtml(plainTitle)}</h3>
                <p>${escapeHtml(previewText) || 'No content'}</p>
            </div>
            <!-- Menu Button -->
            <button class="sidebar-menu-btn" onclick="event.stopPropagation(); toggleNoteMenu(event, '${note.id}')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="1"></circle>
                    <circle cx="12" cy="5" r="1"></circle>
                    <circle cx="12" cy="19" r="1"></circle>
                </svg>
            </button>
            
            <!-- Dropdown (Hidden Key) -->
            <div id="menu-${note.id}" class="sidebar-dropdown hidden" onclick="event.stopPropagation()">
                <div class="menu-item" onclick="shareNote('${note.id}')">Collaborate</div>
                <div class="menu-divider"></div>
                ${note.userId === currentUser.uid 
                    ? `<div class="menu-item" onclick="deleteNoteItem('${note.id}')" style="color: #cc0000;">Delete</div>`
                    : `<div class="menu-item" onclick="leaveNote('${note.id}')" style="color: #e67e22;">Leave</div>`
                }
            </div>
        `;
        el.onclick = () => selectNote(note.id);
        notesListEl.appendChild(el);
    });
}

// Generic Modal Logic
function showModal({ title, message, showInput = false, inputPlaceholder = "", confirmText = "Confirm", onConfirm }) {
    const modal = document.getElementById('modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const modalInput = document.getElementById('modal-input');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    const cancelBtn = document.getElementById('modal-cancel-btn');

    // Set Content
    modalTitle.textContent = title;
    
    if (message) {
        modalMessage.textContent = message;
        modalMessage.classList.remove('hidden');
    } else {
        modalMessage.classList.add('hidden');
    }

    if (showInput) {
        modalInput.classList.remove('hidden');
        modalInput.value = "";
        modalInput.placeholder = inputPlaceholder;
    } else {
        modalInput.classList.add('hidden');
    }

    confirmBtn.textContent = confirmText;
    modal.classList.remove('hidden');
    
    if (showInput) modalInput.focus();

    // Clean up previous listeners
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    // Handlers
    const closeModal = () => {
        modal.classList.add('hidden');
        document.removeEventListener('keydown', handleGlobalKeydown); // Clean up global listener
    };

    const handleConfirm = async () => {
        let value = null;
        if (showInput) {
            value = modalInput.value.trim();
        }
        closeModal();
        if (onConfirm) await onConfirm(value);
    };

    // Global Key handler for this modal instance
    const handleGlobalKeydown = (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
        if (e.key === 'Enter') {
            handleConfirm();
        }
    };

    newConfirmBtn.addEventListener('click', handleConfirm);
    newCancelBtn.addEventListener('click', closeModal);
    
    // Add global listener
    document.addEventListener('keydown', handleGlobalKeydown);
    
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };
}

// Actions
async function createNote() {
    if (!currentUser) return;

    showModal({
        title: "Create a Note",
        showInput: true,
        inputPlaceholder: "Enter note title or a note key...",
        confirmText: "Create",
        onConfirm: async (inputVal) => {
            const trimmed = inputVal ? inputVal.trim() : "";
            
            // Check if it is a Share Key (8 chars, Alphanumeric usually)
            // Current keys are 8 chars.
            if (trimmed.length === 8 && /^[A-Z0-9]+$/.test(trimmed)) {
                // Attempt to connect
                await connectToNote(trimmed);
                return;
            }

            try {
                const finalTitle = trimmed || "Untitled Note";
                const docRef = await addDoc(collection(db, "notes"), {
                    userId: currentUser.uid,
                    title: finalTitle,
                    content: "",
                    titleAlign: 'left', // Default
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                });
                activeNoteId = docRef.id;
            } catch (error) {
                console.error("Error creating note:", error);
                alert("Failed to create note");
            }
        }
    });

    // Dynamic Button Text Logic
    const input = document.getElementById('modal-input');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    
    // Remove old listeners if any (simple way)
    const newHandler = (e) => {
        const val = e.target.value.trim();
        if (val.length === 8 && /^[A-Z0-9]+$/.test(val)) {
            confirmBtn.textContent = "Join";
            confirmBtn.classList.add('accent-btn'); // Optional styling
        } else {
            confirmBtn.textContent = "Create";
            confirmBtn.classList.remove('accent-btn');
        }
    };
    
    input.oninput = newHandler;
}

window.deleteNoteItem = (id) => {
    showModal({
        title: "Delete Note",
        message: "Are you sure you want to delete this note? This action cannot be undone.",
        showInput: false,
        confirmText: "Delete",
        onConfirm: async () => {
            try {
                await deleteDoc(doc(db, "notes", id));
                if (activeNoteId === id) showEmptyState();
            } catch (error) {
                console.error("Error deleting note", error);
                alert("Error deleting note");
            }
        }
    });
};

// Sidebar Toggle Logic
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
});

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    // We strictly use Alt now
    if (!e.altKey) return;

    const key = e.key.toLowerCase();

    // Alt + N: New Note
    if (key === 'n') {
        e.preventDefault(); 
        createNote();
        return;
    }

    // Alt + B: Toggle Sidebar
    if (key === 'b') {
        e.preventDefault();
        sidebar.classList.toggle('collapsed');
        return;
    }

    // Alt + T: Edit Title
    if (key === 't') {
        e.preventDefault(); 
        if (!editorView.classList.contains('hidden')) {
            noteTitleInput.focus();
            // Select all text for ContentEditable
            const range = document.createRange();
            range.selectNodeContents(noteTitleInput);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
        return;
    }

    // Alt + U: Focus Editor (Main Text Area)
    if (key === 'u') {
        e.preventDefault();
        if (!editorView.classList.contains('hidden')) {
            noteContentInput.focus();
        }
        return;
    }

    // Alt + D: Delete Active Note
    if (key === 'd') {
        e.preventDefault();
        if (activeNoteId) {
            deleteNoteItem(activeNoteId);
        }
        return;
    }

    // Alt + Up/Down: Switch Note
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!notes || notes.length === 0) return;

        const direction = e.key === 'ArrowDown' ? 1 : -1;
        const currentIndex = notes.findIndex(n => n.id === activeNoteId);
        
        let newIndex;
        if (currentIndex === -1) {
            newIndex = 0;
        } else {
            newIndex = currentIndex + direction;
        }

        // Clamp index
        if (newIndex >= 0 && newIndex < notes.length) {
            selectNote(notes[newIndex].id);
        }
    }
});

function selectNote(noteId) {
    activeNoteId = noteId;
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    // Update UI
    renderNotesList(); // Re-render to update 'active' class
    editorView.classList.remove('hidden');
    emptyState.classList.add('hidden');
    
    // Set values
    // Use innerHTML to support rich text (saved alignment)
    noteTitleInput.innerHTML = note.title || ""; 
    noteContentInput.innerHTML = note.content || "";
    
    // Restore Title Alignment
    noteTitleInput.style.textAlign = note.titleAlign || 'left';

    // INITIALIZE OPTIMIZATION STATE
    lastSavedState = {
        id: note.id,
        title: note.title || "",
        content: note.content || "",
        titleAlign: note.titleAlign || 'left'
    };

    // Ensure placeholder is correct
    checkPlaceholder();
}

function showEmptyState() {
    activeNoteId = null;
    editorView.classList.add('hidden');
    emptyState.classList.remove('hidden');
    lastSavedState = { id: null, title: null, content: null, titleAlign: null }; // Reset
}

// Auto-save Logic
function handleInput() {
    if (!activeNoteId || !currentUser) return;
    
    // --- Locking Logic ---
    const note = notes.find(n => n.id === activeNoteId);
    if (note && note.lockedBy && note.lockedBy !== currentUser.uid) {
        // Should not be able to type, but if they did, revert?
        // Rely on UI being disabled, but safe guard here?
        return; 
    }
    
    // Acquire Lock if not yours
    if (note && (!note.lockedBy || note.lockedBy !== currentUser.uid)) {
        if (!isAcquiringLock) {
             isAcquiringLock = true;
             // Fire and forget lock acquisition
             updateDoc(doc(db, "notes", activeNoteId), {
                 lockedBy: currentUser.uid,
                 lockedByEmail: currentUser.email, // Store email for display
                 lockedAt: serverTimestamp()
             })
             .catch(err => console.error("Lock error", err))
             .finally(() => {
                 isAcquiringLock = false;
             });
        }
    }

    saveStatus.classList.remove('show');
    clearTimeout(saveTimeout);

    // Capture the ID of this specific timeout to verify later
    const thisTimeoutId = setTimeout(async () => {
        // Save INNER HTML to persist formatting like <div style="text-align: right">...</div>
        const title = noteTitleInput.innerHTML;
        const content = noteContentInput.innerHTML;
        // Capture alignment explicitly
        const titleAlign = noteTitleInput.style.textAlign || 'left';

        // --- OPTIMIZATION CHECK ---
        // If content strictly matches what we think is saved, ABORT save.
        if (lastSavedState.id === activeNoteId &&
            lastSavedState.title === title &&
            lastSavedState.content === content &&
            lastSavedState.titleAlign === titleAlign) {
            
            // It matches previous save, so we are "Saved"
            saveStatus.textContent = "Saved";
            saveStatus.classList.add('show');
            if (saveTimeout === thisTimeoutId) saveTimeout = null;
            return;
        }

        try {
            const noteRef = doc(db, "notes", activeNoteId);
            await updateDoc(noteRef, {
                title: title,
                content: content,
                titleAlign: titleAlign,
                updatedAt: serverTimestamp(),
                lockedBy: null // Release Lock
            });
            
            // Update Local Cache
            lastSavedState = {
                id: activeNoteId,
                title: title,
                content: content,
                titleAlign: titleAlign
            };

            saveStatus.textContent = "Saved";
            saveStatus.classList.add('show');
            
            // Fix: Only clear saveTimeout if WE are the active timer.
            // If user typed again, saveTimeout would be a NEW ID.
            if (saveTimeout === thisTimeoutId) {
                saveTimeout = null; // Mark as clean/idle
            }
        } catch (error) {
            console.error("Error saving note:", error);
            saveStatus.textContent = "Error saving";
            saveStatus.classList.add('show');
            // Do not clear timeout on error? Or retry? 
            // For now, let's clear it to avoid blocking updates forever if stuck.
            if (saveTimeout === thisTimeoutId) {
                saveTimeout = null;
            }
        }
    }, 2000); // Debounce for 2 seconds
    
    saveTimeout = thisTimeoutId;
    
    // Placeholder Logic
    checkPlaceholder();
}

function checkPlaceholder() {
    if (!noteContentInput) return;
    // Check text content
    const text = noteContentInput.innerText.trim();
    // Check for images
    const hasImage = noteContentInput.querySelector('img');
    
    if (!text && !hasImage) {
        noteContentInput.classList.add('empty');
    } else {
        noteContentInput.classList.remove('empty');
    }
}

createNoteBtn.addEventListener('click', createNote);
noteTitleInput.addEventListener('input', handleInput);
noteContentInput.addEventListener('input', handleInput);

// Context Menu Logic
const contextMenu = document.getElementById('context-menu');
const imageContextMenu = document.getElementById('image-context-menu');
let contextMenuTargetType = null; // 'title' or 'content' or 'image'
let savedSelectionRange = null;

// Font Controls
const fontSizeInput = document.getElementById('font-size-input');
const fontIncBtn = document.getElementById('font-inc-btn');
const fontDecBtn = document.getElementById('font-dec-btn');

function showContextMenu(e, type) {
    if (e) e.preventDefault();
    contextMenuTargetType = type;
    
    // Save selection so we can restore it before execCommand
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        savedSelectionRange = selection.getRangeAt(0);
        
        // --- Font Size Detection ---
        let parent = selection.anchorNode;
        // If text node, get parent
        if (parent.nodeType === 3) parent = parent.parentElement;
        
        if (parent.nodeType === 3) parent = parent.parentElement;
        
        // If we clicked the editor container directly (empty), use it
        if (parent === noteContentInput || parent === noteTitleInput) {
             // ensure we read from the element itself
        }


        const computed = window.getComputedStyle(parent);
        if (computed.fontSize) {
            let size = parseInt(computed.fontSize);
            // Fix for browser default 16px when we enforced 15px
            // If it reads 16px but we want 15px default, it might be a specificity issue
            // OR we just want to force 15 if it seems like a default block?
            // User claim: "displays 16 even if its actually 15". 
            // This implies rounding or mismatch.
            // Let's rely on truth, but if we are at root, maybe trust the Input Default?
            fontSizeInput.value = size;
        } else {
            fontSizeInput.value = 15; // Default fallback
        }

        // --- Font Family Detection ---
        let currentFont = document.queryCommandValue('fontName');
        if (currentFont) {
             currentFont = currentFont.replace(/['"]/g, ''); // Remove quotes
        } else {
             // Fallback
             const fontFamily = computed.fontFamily;
             if (fontFamily) {
                 currentFont = fontFamily.split(',')[0].replace(/['"]/g, '');
             }
        }
        
        const fontNameDisplay = document.getElementById('current-font-name');
        if (fontNameDisplay) fontNameDisplay.textContent = currentFont || "Default";

    } else {
        savedSelectionRange = null;
    }

    const menuToUse = contextMenuTargetType === 'image' ? imageContextMenu : contextMenu;

    // Position menu
    menuToUse.classList.remove('hidden'); // Unhide first to get dimensions
    
    // Check horizontal space for Submenus
    // Submenus open at 100% left of parent items.
    // So we need clear space from (left + offsetWidth) to window.innerWidth
    // Standard submenu width approx 200px
    const requiredSubmenuSpace = 220; 
    let alignSubmenusLeft = false;

    const menuHeight = menuToUse.offsetHeight;
    const padding = 10;
    
    let top = e.clientY;
    let left = e.clientX;
    
    // Check vertical overflow
    if (top + menuHeight + padding > window.innerHeight) {
        top = e.clientY - menuHeight;
    }
    
    // Check horizontal overflow (of main menu)
    if (left + menuToUse.offsetWidth + padding > window.innerWidth) {
        left = window.innerWidth - menuToUse.offsetWidth - padding;
    }
    
    // NOW Check for Submenu space based on the FINAL left position
    const spaceForSubmenu = window.innerWidth - (left + menuToUse.offsetWidth);
    if (spaceForSubmenu < requiredSubmenuSpace) {
        alignSubmenusLeft = true;
    }

    if (alignSubmenusLeft) {
        menuToUse.classList.add('align-submenus-left');
    } else {
        menuToUse.classList.remove('align-submenus-left');
    }

    menuToUse.style.left = `${left}px`;
    menuToUse.style.top = `${top}px`;
}

function handleContextMenu(e) {
    if (editorView.classList.contains('hidden')) return;

    // Check if clicked inside title
    if (noteTitleInput.contains(e.target)) {
        showContextMenu(e, 'title');
        return;
    }

    // Check if clicked inside content
    if (noteContentInput.contains(e.target)) {
        if (e.target.tagName === 'IMG') {
            selectedImage = e.target; // Ensure selected
            initResizer();
            updateResizerPosition();
            updateImageMenuValues(); // Populate inputs
            showContextMenu(e, 'image');
        } else {
            showContextMenu(e, 'content');
        }
        return;
    }
}

// Global click to hide context menu
// Global click to hide context menu
// We use mousedown to capture the intent *before* cursor moves
document.addEventListener('mousedown', (e) => {
    // If menu is hidden, do nothing special
    if (contextMenu.classList.contains('hidden') && imageContextMenu.classList.contains('hidden')) return;

    // If clicking inside menu, allow it (check both menus)
    if (contextMenu.contains(e.target)) return;
    if (imageContextMenu && imageContextMenu.contains(e.target)) return;
    
    // If clicking outside...
    // If clicking outside...
    // Check if clicking in the editor (where the cursor is presumed to be "ready")
    if (noteContentInput.contains(e.target) || noteTitleInput.contains(e.target)) {
        // User requesting "Click to close only" behavior.
        // preventDefault stops the cursor move.
        e.preventDefault();
        e.stopPropagation();
        
        // Hide menu
        contextMenu.classList.add('hidden');
        if (imageContextMenu) imageContextMenu.classList.add('hidden');
        
        // Ensure focus remains (prevent default keeps it usually, but let's be safe)
        // Actually, if we preventDefault on mousedown, focus might not transfer if it wasn't there.
        // But the context menu flow kept focus on input.
        // We can re-focus just in case.
         if (contextMenuTargetType === 'title') noteTitleInput.focus();
         else noteContentInput.focus();
    } else {
        // Clicking elsewhere (sidebar, etc), just close menu
        contextMenu.classList.add('hidden');
        imageContextMenu.classList.add('hidden');
    }
});

// Also hide on typing
const hideMenuOnType = () => {
    if (!contextMenu.classList.contains('hidden')) {
        contextMenu.classList.add('hidden');
    }
    if (!imageContextMenu.classList.contains('hidden')) {
        imageContextMenu.classList.add('hidden');
    }
};
noteContentInput.addEventListener('keydown', hideMenuOnType);
noteTitleInput.addEventListener('keydown', hideMenuOnType);

// Helper to restore selection
function restoreSelection() {
    if (savedSelectionRange) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(savedSelectionRange);
        return true;
    }
    return false;
}

// Menu Action Handlers
document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
        // e.stopPropagation(); // Don't stop propagation, let bubbling happen if needed, but we handle it here.
        // Actually, if we click a submenu trigger, we might NOT want to close the menu.
        // But the current logic blindly closes the menu at the end.
        
        const action = item.getAttribute('data-action');
        
        // If it's a submenu trigger (no action), just return and DO NOT close menu
        if (!action) {
            e.stopPropagation(); // Create safety to prevent closing if parent has listeners?
            return; 
        }
        
        if (contextMenuTargetType === 'title') {
            if (action.startsWith('justify')) {
                const align = action.replace('justify', '').toLowerCase();
                noteTitleInput.style.textAlign = align;
            } else if (action === 'paste') {
                try {
                    noteTitleInput.focus();
                    restoreSelection(); // Restore if possible, usually title selection is simple
                    const text = await navigator.clipboard.readText();
                    document.execCommand('insertText', false, text);
                } catch (err) {
                    console.error('Paste failed', err);
                    alert('Please use Ctrl+V to paste');
                }
            } else if (['bold', 'italic', 'underline', 'copy', 'cut'].includes(action)) {
                 restoreSelection();
                 document.execCommand(action, false, null);
            }
            handleInput();
        } 
        else if (contextMenuTargetType === 'content') {
            restoreSelection(); // Important: Restore cursor position!
            noteContentInput.focus();

            if (action === 'paste') {
                try {
                    const text = await navigator.clipboard.readText();
                    document.execCommand('insertText', false, text);
                } catch (err) {
                    console.error('Paste failed', err);
                    alert('Please use Ctrl+V to paste');
                }
        } else if (action === 'insertImage') {
                // Trigger hidden input
                document.getElementById('img-upload-hidden').click();
            } else if (['bold', 'italic', 'underline', 'justifyLeft', 'justifyCenter', 'justifyRight', 'copy', 'cut'].includes(action)) {
                document.execCommand(action, false, null);
            }
            handleInput();
        }
        
        contextMenu.classList.add('hidden');
    });
});

// Image Insertion Logic
// Helper: Compress Image
function compressImage(file) {
    return new Promise((resolve, reject) => {
        const MAX_WIDTH = 1024;
        const QUALITY = 0.7; // 70% JPEG quality
        
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                
                // Resize logic
                if (width > MAX_WIDTH) {
                    height = Math.round(height * (MAX_WIDTH / width));
                    width = MAX_WIDTH;
                }
                
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Export as JPEG with compression
                const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
                resolve(dataUrl);
            };
            img.onerror = (err) => reject(err);
        };
        reader.onerror = (err) => reject(err);
    });
}

// Image Insertion Logic
const imgUploadInput = document.getElementById('img-upload-hidden');
imgUploadInput.addEventListener('change', async (e) => { // Made async
    const file = e.target.files[0];
    if (!file) return;

    try {
        // Show loading state if needed? (Optional for now)
        const base64 = await compressImage(file);
        
        restoreSelection();
        noteContentInput.focus();
        document.execCommand('insertImage', false, base64);
        
        // Fix: Auto-save immediately to persist image
        handleInput();
        
        // Reset input
        imgUploadInput.value = '';
    } catch (err) {
        console.error("Image processing failed", err);
        alert("Failed to process image.");
    }
});

// Image Resizer Logic
let selectedImage = null;
let resizerOverlay = null;

function initResizer() {
    // Create overlay if not exists
    if (!resizerOverlay) {
        resizerOverlay = document.createElement('div');
        resizerOverlay.className = 'resizer-overlay';
        resizerOverlay.innerHTML = '<div class="resizer-handle"></div>';
        document.body.appendChild(resizerOverlay);
        
        // Handle Drag
        const handle = resizerOverlay.querySelector('.resizer-handle');
        handle.addEventListener('mousedown', initDrag);
    }
}

function updateResizerPosition() {
    if (!selectedImage || !resizerOverlay) return;
    
    // Capture local reference to prevent crash if selectedImage becomes null during async frame
    const img = selectedImage;
    const overlay = resizerOverlay;

    const rectify = () => {
        if (!img || !overlay) return; // Safety check
        // Check if img is still in DOM (optional but good)
        if (!document.body.contains(img)) return;

        const rect = img.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.top = (rect.top + scrollTop) + 'px';
        overlay.style.left = (rect.left + scrollLeft) + 'px';
        overlay.classList.add('active');
    };
    
    // Slight delay to allow layout to settle if needed, or call directly
    requestAnimationFrame(rectify);
}

function hideResizer() {
    if (resizerOverlay) resizerOverlay.classList.remove('active');
    selectedImage = null;
}

// Global click to select images
document.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG' && noteContentInput.contains(e.target)) {
        selectedImage = e.target;
        initResizer();
        updateResizerPosition();
    } else if (resizerOverlay && !resizerOverlay.contains(e.target) && e.target !== selectedImage && !imageContextMenu.contains(e.target)) {
        hideResizer();
    }
});

// Update position on scroll/resize
window.addEventListener('resize', updateResizerPosition);
noteContentInput.addEventListener('scroll', updateResizerPosition);

// Drag Logic
function initDrag(e) {
    if (!selectedImage) return;
    e.preventDefault();
    e.stopPropagation(); // Don't lose focus or hide menu logic
    
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = parseInt(document.defaultView.getComputedStyle(selectedImage).width, 10);
    const startHeight = parseInt(document.defaultView.getComputedStyle(selectedImage).height, 10);
    
    const doDrag = (e) => {
        const newWidth = startWidth + (e.clientX - startX);
        const newHeight = startHeight + (e.clientY - startY);
        
        selectedImage.style.width = newWidth + 'px';
        selectedImage.style.height = newHeight + 'px';
        updateResizerPosition();
    };
    
    const stopDrag = () => {
        document.removeEventListener('mousemove', doDrag);
        document.removeEventListener('mouseup', stopDrag);
        handleInput(); // Save new size
    };
    
    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', stopDrag);
}

// Color Logic
document.querySelectorAll('.color-swatch:not(.picker-swatch)').forEach(swatch => {
    swatch.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent closing menu immediately?? Or close it?
        // User probably expects menu to close after picking a color
        const color = swatch.getAttribute('data-color');
        applyColor(color);
        contextMenu.classList.add('hidden');
    });
});

const customColorInput = document.getElementById('custom-color-input');
if (customColorInput) {
    // Only lock on click (opening)
    customColorInput.addEventListener('click', (e) => {
        // e.stopPropagation(); // DO WE NEED TO STOP PROPAGATION? 
        // If we stop prop, the global mousedown might not fire, which is fine.
        // But preventing default might stop the picker.
        // We just want to effectively lock the menu.
        
        const submenu = customColorInput.closest('.submenu');
        if (submenu) submenu.classList.add('locked');
    });

    // Input fires as you drag color
    customColorInput.addEventListener('input', (e) => {
        const color = e.target.value;
        applyColor(color);
    });

    // Change fires on commit/close
    customColorInput.addEventListener('change', (e) => {
       const color = e.target.value;
       applyColor(color);
       contextMenu.classList.add('hidden');
       
       const submenu = customColorInput.closest('.submenu');
       if (submenu) submenu.classList.remove('locked');
    });
}

function applyColor(color) {
    if (savedSelectionRange) {
        restoreSelection();
    }
    
    // Choose target
    const targetInput = contextMenuTargetType === 'title' ? noteTitleInput : noteContentInput;
    targetInput.focus();
    
    // IMPORTANT: Enable CSS styling mode to produce <span style="color:..."> instead of <font color="...">
    // This helps avoid deprecated font tag quirks including size resetting.
    if (document.queryCommandSupported('styleWithCSS')) {
        document.execCommand('styleWithCSS', false, true);
    }
    
    document.execCommand('foreColor', false, color);
    
    // Optional: Turn it back off if you prefer structural editing for other things, 
    // but usually CSS mode is better for modern web.
    // document.execCommand('styleWithCSS', false, false);

    handleInput();
}

// Font Size Helpers
function setFontSize(size) {
    // Restore selection first so execCommand works on the right range
    if (savedSelectionRange) {
        restoreSelection();
    }


    // Handle Collapsed Selection (Upcoming Text)
    const selection = window.getSelection();
    if (selection.rangeCount > 0 && selection.getRangeAt(0).collapsed) {
        const range = selection.getRangeAt(0);
        // Create a span with the desired size
        // Create a span with the desired size
        const span = document.createElement('span');
        span.style.fontSize = `${size}px`;
        // Removed explicit line-height/vertical-align to allow natural flow
        // span.style.lineHeight = 'normal';
        // span.style.verticalAlign = 'baseline';
        
        // Insert Zero Width Space to give the cursor something to "be in"
        // We use a Text Node specifically
        const zwsp = document.createTextNode('\u200B');
        span.appendChild(zwsp);
        
        range.insertNode(span);
        
        // Place Cursor INSIDE the Text Node
        const newRange = document.createRange();
        // Position at offset 1 (after the ZWSP character)
        // This ensures subsequent typing is appended to this text node
        newRange.setStart(zwsp, 1);
        newRange.setEnd(zwsp, 1);
        newRange.collapse(true);
        
        selection.removeAllRanges();
        selection.addRange(newRange);
        
        savedSelectionRange = newRange.cloneRange();
        
        handleInput();
        return;
    }
    
    // Determine target based on context
    const targetInput = contextMenuTargetType === 'title' ? noteTitleInput : noteContentInput;
    
    // Ensure focus
    targetInput.focus();
    
    // Use execCommand 'fontSize' with value '7' as a marker.
    // This lets the browser handle all the complex node splitting for partial selections.
    document.execCommand('fontSize', false, '7');
    
    // Find the elements created (look for font size 7)
    // Note: execCommand with styleWithCSS:false creates <font size="7">
    const fontTags = targetInput.getElementsByTagName('font');
    const spansToSelect = [];
    
    // Convert live collection to static array for iteration
    const tagsToReplace = [];
    for (let i = 0; i < fontTags.length; i++) {
        if (fontTags[i].getAttribute('size') === '7') {
            tagsToReplace.push(fontTags[i]);
        }
    }
    
    // Replace <font size="7"> with <span style="...">
    // Replace <font size="7"> with <span style="..."> or apply to parent block
    tagsToReplace.forEach(font => {
        const parent = font.parentNode;
        let isFullBlock = false;
        
        // Check if parent is a block element and not the editor root
        // (div is standard for lines in contenteditable div)
        const isBlock = ['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(parent.tagName);
        const isRoot = (parent === targetInput);
        
        if (isBlock && !isRoot) {
            // Check if font tag contains effectively all the content
            const siblings = Array.from(parent.childNodes).filter(n => n !== font);
            const hasVisibleSiblings = siblings.some(n => {
                // Text node with content
                if (n.nodeType === 3) return n.textContent.trim().length > 0;
                // BR is usually a placeholder or break; if it's the only thing, we can probably ignore it 
                // but usually the browser removes BR if text is added. 
                // If BR exists alongside text, it might be meaningful. 
                // Let's be conservative: visible siblings = text or elements that are not BR?
                // Actually, if there is a BR, it might force a line break if not at end. 
                // Let's ignore BR for now as it typically sits at end of line.
                if (n.tagName === 'BR') return false;
                return true; 
            });
            
            if (!hasVisibleSiblings) isFullBlock = true;
        }

        if (isFullBlock) {
            // Apply to Parent Block to fix Line Height / Strut issues
            parent.style.fontSize = `${size}px`;
            // parent.style.lineHeight = 'normal'; // Optional: let it inherit or set normal
            
            // Move children out of font tag
            while (font.firstChild) {
                parent.insertBefore(font.firstChild, font);
            }
            parent.removeChild(font);
            spansToSelect.push(parent);
        } else {
            // Standard Span Replacement
            const span = document.createElement('span');
            span.style.fontSize = `${size}px`;
            // normal line height allows the span to shrink/grow, 
            // but parent strut might still impose min-height.
            // But this is the best we can do for partial selections.
            span.style.lineHeight = 'normal'; 
            span.style.verticalAlign = 'baseline';
            
            while (font.firstChild) {
                span.appendChild(font.firstChild);
            }
            
            if (font.parentNode) {
                font.parentNode.replaceChild(span, font);
                spansToSelect.push(span);
            }
        }
    });

    // Re-select the modified area to allow continuous updates
    if (spansToSelect.length > 0) {
        const newRange = document.createRange();
        
        if (spansToSelect.length === 1) {
            // Best case: select the text inside the span
            // This ensures startContainer is the span (or text inside), giving correct computed style
            newRange.selectNodeContents(spansToSelect[0]);
        } else {
            // Multiple spans: Select across them
            newRange.setStartBefore(spansToSelect[0]);
            newRange.setEndAfter(spansToSelect[spansToSelect.length - 1]);
        }
        
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(newRange);
        
        // Update saved selection
        savedSelectionRange = newRange.cloneRange();
    }
    
    handleInput();
}

fontSizeInput.addEventListener('change', (e) => {
    setFontSize(e.target.value);
});

function getCurrentFontSize() {
    let currentSize = 15; // Default fallback
    if (savedSelectionRange) restoreSelection();
    
    const selection = window.getSelection();
    if (selection.rangeCount) {
         let node = selection.getRangeAt(0).startContainer;
         // If we are at the beginning of a span selected by selectNodeContents, 
         // startContainer might be the span itself.
         if (node.nodeType === Node.ELEMENT_NODE) {
             // If we selected a range of nodes, check the child at offset?
             // Or just check the container's font size directly (if it's the span)
             // or check the first child if it exists.
             if (node.tagName === 'SPAN' && node.style.fontSize) {
                 // It is the span!
             } else {
                 // It's likely the parent div. Check children.
                 // This path is tricky. Let's rely on computed style of the node unless it is the editor itself.
                 if (node === noteContentInput) {
                     // Dig deeper?
                     const child = node.childNodes[selection.getRangeAt(0).startOffset];
                     if (child && child.nodeType === Node.ELEMENT_NODE) node = child;
                     else if (child && child.nodeType === Node.TEXT_NODE) node = child.parentElement;
                 }
             }
         } else if (node.nodeType === Node.TEXT_NODE) {
             node = node.parentNode;
         }
         
         const computed = window.getComputedStyle(node).fontSize;
         if (computed) {
             // parseInt can truncate 13.333 to 13. Math.round handles it better for closest "step".
             currentSize = Math.round(parseFloat(computed));
         }
    }
    return currentSize;
}

// Prevents Focus Loss
const preventFocusLoss = (e) => e.preventDefault();

fontIncBtn.addEventListener('mousedown', preventFocusLoss);
fontDecBtn.addEventListener('mousedown', preventFocusLoss);
// fontSizeInput.addEventListener('mousedown', preventFocusLoss); // Removed to allow typing

// Lock menu when typing in font size
fontSizeInput.addEventListener('focus', () => {
    const submenu = fontSizeInput.closest('.submenu');
    const menu = fontSizeInput.closest('.context-menu');
    if (submenu) submenu.classList.add('locked');
    if (menu) menu.classList.add('child-locked');
});

fontSizeInput.addEventListener('blur', () => {
    const submenu = fontSizeInput.closest('.submenu');
    const menu = fontSizeInput.closest('.context-menu');
    if (submenu) submenu.classList.remove('locked');
    if (menu) menu.classList.remove('child-locked');
});

fontIncBtn.addEventListener('click', (e) => {
    e.preventDefault(); 
    const currentSize = getCurrentFontSize();
    const newSize = currentSize + 2;
    fontSizeInput.value = newSize; 
    setFontSize(newSize);
});

fontDecBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const currentSize = getCurrentFontSize();
    const newSize = Math.max(8, currentSize - 2);
    fontSizeInput.value = newSize;
    setFontSize(newSize);
});

document.addEventListener('contextmenu', handleContextMenu);


// --- Autocomplete Logic ---
const suggestionBox = document.getElementById('suggestion-box');
let uniqueWords = new Set();

function updateDictionary() {
    if (!noteContentInput) return;
    const text = noteContentInput.innerText || "";
    // Match words of 2+ characters
    const words = text.match(/\b\w{2,}\b/g);
    
    // To avoid adding the *partial* word currently being typed:
    // We could try to identify the active word? 
    // Ideally, we only add words that are 'finished'. 
    // A simple heuristic: Only add words that are NOT the very last word if it doesn't end with whitespace?
    // But user acts on 'blur'. 
    // Let's just trust the regex for now, but ensure we don't *suggest* the exact partial match.
    // User complaint: "not partial versions". This likely means if I type "Computer", don't suggest "Compu" (which I might have typed earlier and saved).
    
    if (words) {
        // Clear and rebuild to avoid stale partials
        uniqueWords.clear(); 
        words.forEach(w => uniqueWords.add(w));
    }
}

// Update dictionary on space (word completion) or blur
noteContentInput.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
        // Allow a tiny delay for the character to enter DOM
        setTimeout(updateDictionary, 100);
    }
});
noteContentInput.addEventListener('blur', updateDictionary);

let activeSuggestionIndex = 0;
let currentSuggestions = [];

function hideSuggestions() {
    suggestionBox.classList.add('hidden');
    currentSuggestions = [];
    activeSuggestionIndex = 0;
}

function showSuggestions(suggestions, rect) {
    if (!suggestions.length) {
        hideSuggestions();
        return;
    }
    currentSuggestions = suggestions;
    activeSuggestionIndex = 0;
    
    // Render
    suggestionBox.innerHTML = suggestions.map((w, i) => `
        <li class="suggestion-item ${i === 0 ? 'active' : ''}" data-index="${i}">
            <span>${w}</span>
        </li>
    `).join('');
    
    // Add Click Listeners
    suggestionBox.querySelectorAll('.suggestion-item').forEach((item, index) => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Prevent blur of editor
            insertSuggestion(suggestions[index]);
        });
    });

    // Position (rect is relative to viewport)
    suggestionBox.style.left = `${rect.left}px`;
    suggestionBox.style.top = `${rect.bottom + 5}px`;
    suggestionBox.classList.remove('hidden');
}

// Watch input for suggestions
noteContentInput.addEventListener('keyup', (e) => {
    // Ignore Nav keys handled by keydown
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') return;
    
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    
    // Check if we are at the end of a word
    const textNode = range.startContainer;
    if (textNode.nodeType !== Node.TEXT_NODE) {
        hideSuggestions();
        return;
    }
    
    const text = textNode.textContent;
    const offset = range.startOffset;
    
    // Get Word Fragment before cursor
    const beforeCursor = text.slice(0, offset);
    const match = beforeCursor.match(/(\w+)$/);
    
    if (match) {
        const query = match[1];
        if (query.length < 1) { 
             hideSuggestions();
             return;
        }
        
        // Filter
        // 1. Must start with query
        // 2. Must not be the query itself (exact match)
        // 3. Must be strictly longer (to avoid partials if stored)
        const matches = Array.from(uniqueWords).filter(w => 
            w.toLowerCase().startsWith(query.toLowerCase()) && 
            w.toLowerCase() !== query.toLowerCase() &&
            w.length > query.length 
        ).slice(0, 5); 
        
        if (matches.length > 0) {
            const rect = range.getBoundingClientRect();
            showSuggestions(matches, rect);
        } else {
            hideSuggestions();
        }
    } else {
        hideSuggestions();
    }
});

// Navigate Suggestions
document.addEventListener('keydown', (e) => {
    if (suggestionBox.classList.contains('hidden')) return;
    
    // Cancel on Space
    if (e.key === ' ') {
        hideSuggestions();
        return;
    }
    
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
        updateSuggestionUI();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        updateSuggestionUI();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertSuggestion(currentSuggestions[activeSuggestionIndex]);
    } else if (e.key === 'Escape') {
        hideSuggestions();
    }
});

function updateSuggestionUI() {
    const items = suggestionBox.querySelectorAll('.suggestion-item');
    items.forEach((item, i) => {
        if (i === activeSuggestionIndex) item.classList.add('active');
        else item.classList.remove('active');
    });
}

function insertSuggestion(word) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const textNode = range.startContainer;
    const offset = range.startOffset;
    const text = textNode.textContent;
    
    // Find start of word
    const beforeCursor = text.slice(0, offset);
    const match = beforeCursor.match(/(\w+)$/);
    
    if (match) {
        const start = match.index;
        // Replace current token with full word + space
        range.setStart(textNode, start);
        range.setEnd(textNode, offset);
        range.deleteContents();
        
        // Insert text node
        const newTextNode = document.createTextNode(word + " ");
        range.insertNode(newTextNode);
        
        // Correctly move cursor to AFTER the space
        range.setStartAfter(newTextNode);
        range.setEndAfter(newTextNode); 
        selection.removeAllRanges();
        selection.addRange(range);
        
        // Re-focus
        noteContentInput.focus();
    }
    
    hideSuggestions();
    handleInput();
}


// Helper for Alt+T Select All in ContentEditable
function selectAllContent(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

// Small tweak to Shortcuts using helper
// ... We need to update the keydown listener to use selectAllContent instead of .select()
// Updating strictly the listeners part below...

// Title Enter Key Block (Optional but good for "Wrapping" vs "New Line")
// User said "come into the next line" (Visual Wrap) which div does.
// User didn't say we CAN'T have new lines in title, but usually title is one block.
// Let's allow default behavior for now, wrapping happens naturally.



// --- Font Selection Logic ---
const changeFontTrigger = document.getElementById('change-font-trigger');
const fontPickerOverlay = document.getElementById('font-picker-overlay');
const fontPickerCancel = document.getElementById('font-picker-cancel');
const fontSearch = document.getElementById('font-search');
const fontListEl = document.getElementById('font-list');
const currentFontNameDisplay = document.getElementById('current-font-name');

const AVAILABLE_FONTS = [
    "Inter", "Arial", "Verdana", "Helvetica", "Times New Roman", 
    "Courier New", "Georgia", "Trebuchet MS", "Impact", "Comic Sans MS",
    "Segoe UI", "Tahoma", "Geneva", "Palatino Linotype", "Book Antiqua"
];

function renderFontList(filter = "") {
    if (!fontListEl) return;
    fontListEl.innerHTML = "";
    
    const current = currentFontNameDisplay ? currentFontNameDisplay.textContent : "";
    
    AVAILABLE_FONTS.forEach(font => {
        if (font.toLowerCase().includes(filter.toLowerCase())) {
            const li = document.createElement('li');
            li.className = 'font-option';
            if (font === current) li.classList.add('active-font');
            li.innerHTML = `
                <span style="font-family: '${font}'">${font}</span>
                ${font === current ? '<span style="color: var(--accent-color);">✓</span>' : ''}
            `;
            li.onclick = () => applyFont(font);
            fontListEl.appendChild(li);
        }
    });

    if (fontListEl.children.length === 0) {
        fontListEl.innerHTML = '<li style="padding:12px; color:#999; text-align:center;">No fonts found</li>';
    }
}

function showFontPicker() {
    contextMenu.classList.add('hidden'); // Close context menu
    if (fontPickerOverlay) {
        fontPickerOverlay.classList.remove('hidden');
        renderFontList();
        if (fontSearch) {
            fontSearch.value = "";
            fontSearch.focus();
        }
    }
}

function closeFontPicker() {
    if (fontPickerOverlay) fontPickerOverlay.classList.add('hidden');
}

function applyFont(fontName) {
    closeFontPicker();
    // Restore selection
    if (savedSelectionRange) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(savedSelectionRange);
    }
    
    noteContentInput.focus();
    
    // Apply Font
    // Use execCommand 'fontName'
    document.execCommand('fontName', false, fontName);
    
    // Attempt to convert <font face> to span for consistency, 
    // but execCommand is robust for functionality.
    // Let's do a quick pass to replace <font face="..."> with <span style="font-family:..."> 
    // to match requested behavior and keep things modern.
    const fontTags = noteContentInput.getElementsByTagName('font');
    // We iterate backwards or convert to array to avoid live collection issues
    const tagsToReplace = [];
    for(let i=0; i<fontTags.length; i++) {
        if(fontTags[i].hasAttribute('face')) tagsToReplace.push(fontTags[i]);
    }

    tagsToReplace.forEach(font => {
        // Double check it matches the one we just applied? 
        // Or just convert all legacy font tags to spans
        const span = document.createElement('span');
        span.style.fontFamily = font.getAttribute('face');
        
        // Preserve color/size if present (unlikely from this action alone but possible)
        if (font.getAttribute('color')) span.style.color = font.getAttribute('color');
        if (font.getAttribute('size')) {
            // Mapping size 1-7 to px is approximate, maybe skip or handle later?
            // For now, let's just preserve the font attribute on the span? No, styles are better.
        }

        while (font.firstChild) {
            span.appendChild(font.firstChild);
        }
        if(font.parentNode) font.parentNode.replaceChild(span, font);
    });

    handleInput();
}

if (changeFontTrigger) {
    changeFontTrigger.addEventListener('click', showFontPicker);
}

if (fontPickerCancel) {
    fontPickerCancel.addEventListener('click', closeFontPicker);
}

if (fontSearch) {
    fontSearch.addEventListener('input', (e) => renderFontList(e.target.value));
}


// Close on overlay click
if (fontPickerOverlay) {
    fontPickerOverlay.addEventListener('click', (e) => {
        if (e.target === fontPickerOverlay) closeFontPicker();
    });
}


// --- Collaboration & Sharing Logic ---

// Sidebar Menu Toggle
window.toggleNoteMenu = (e, noteId) => {
    e.stopPropagation();
    
    // Close others
    document.querySelectorAll('.sidebar-dropdown').forEach(el => {
        if (el.id !== `menu-${noteId}`) el.classList.add('hidden');
    });

    const menu = document.getElementById(`menu-${noteId}`);
    if (menu) menu.classList.toggle('hidden');
};

// Global click to close sidebar menus
document.addEventListener('click', (e) => {
    document.querySelectorAll('.sidebar-dropdown').forEach(el => el.classList.add('hidden'));
});

// Generate Key
function generateNoteKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let key = "";
    for (let i = 0; i < 8; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

// Share Note Action
window.shareNote = async (noteId) => {
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    let key = note.shareKey;
    
    // If no key, generate and save
    if (!key) {
        key = generateNoteKey();
        try {
            await updateDoc(doc(db, "notes", noteId), {
                shareKey: key,
                updatedAt: serverTimestamp()
            });
            // Update local object immediately for UI responsiveness
            note.shareKey = key;
        } catch (err) {
            console.error("Error generating share key", err);
            alert("Failed to generate share key");
            return;
        }
    }

    // Show Modal
    const modal = document.getElementById('share-modal-overlay');
    const input = document.getElementById('share-key-input');
    input.value = key;
    modal.classList.remove('hidden');
};

// Close Share Modal
const shareModal = document.getElementById('share-modal-overlay');
const shareCloseBtn = document.getElementById('share-modal-close-btn');
const copyKeyBtn = document.getElementById('copy-key-btn');

if (shareCloseBtn) {
    shareCloseBtn.addEventListener('click', () => {
        shareModal.classList.add('hidden');
    });
}

if (copyKeyBtn) {
    copyKeyBtn.addEventListener('click', () => {
        const input = document.getElementById('share-key-input');
        input.select();
        document.execCommand('copy');
        // Visual feedback?
        const origContent = copyKeyBtn.innerHTML;
        copyKeyBtn.innerHTML = '<span style="font-size:12px">Copied!</span>';
        setTimeout(() => copyKeyBtn.innerHTML = origContent, 1000);
    });
}

// Connect to Note
async function connectToNote(key) {
    if (!currentUser) return;
    
    try {
        const q = query(collection(db, "notes"), where("shareKey", "==", key));
        const querySnapshot = await getDocs(q); 
        
        if (querySnapshot.empty) {
            showModal({ title: "Error", message: "Note not found with that key. Please check and try again.", confirmText: "OK" });
            return;
        }

        const noteDoc = querySnapshot.docs[0];
        const noteData = noteDoc.data();

        // Check if I am already owner or collaborator
        if (noteData.userId === currentUser.uid) {
            showModal({ title: "Info", message: "You are the owner of this note.", confirmText: "OK" });
            return;
        }
        if (noteData.collaborators && noteData.collaborators.includes(currentUser.uid)) {
            showModal({ title: "Info", message: "You have already joined this note.", confirmText: "OK" });
            return;
        }

        // Add to collaborators
        await updateDoc(doc(db, "notes", noteDoc.id), {
            collaborators: arrayUnion(currentUser.uid)
        });

        // Close key modal first
        document.getElementById('modal-overlay').classList.add('hidden');
        
        showModal({ 
            title: "Connected!", 
            message: "You have successfully joined the note. Let's write!", 
            confirmText: "OK" 
        });

    } catch (err) {
        console.error("Connect error", err);
        showModal({ title: "Error", message: "Failed to connect to note. Please check the key.", confirmText: "OK" });
    }
}

// Editor Lock State Update
function updateEditorLockState(note) {
    if (!note) return;

    const isLocked = note.lockedBy && note.lockedBy !== currentUser.uid;
    
    if (isLocked) {
        editorView.classList.add('locked');
        noteTitleInput.contentEditable = "false";
        noteContentInput.contentEditable = "false";
        
        // Show indicator
        let indicator = document.getElementById('locked-indicator');
        const lockedMsg = note.lockedByEmail ? `${note.lockedByEmail} is editing the note...` : "Another user is editing the note...";
        
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'locked-indicator';
            indicator.className = 'locked-indicator';
            indicator.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                <span>${lockedMsg}</span>
            `;
            editorView.prepend(indicator);
        } else {
            // Update message if exists
            indicator.querySelector('span').textContent = lockedMsg;
        }
        indicator.style.display = 'flex';
    } else {
        editorView.classList.remove('locked');
        noteTitleInput.contentEditable = "true";
        noteContentInput.contentEditable = "true";
        
        const indicator = document.getElementById('locked-indicator');
        if (indicator) indicator.style.display = 'none';
    }
}
window.leaveNote = (id) => {
    showModal({
        title: "Leave Note",
        message: "Are you sure you want to leave this shared note? It will be removed from your list.",
        showInput: false,
        confirmText: "Leave",
        onConfirm: async () => {
            try {
                // Remove self from collaborators
                await updateDoc(doc(db, "notes", id), {
                    collaborators: arrayRemove(currentUser.uid)
                });
                // If this note was active, empty state will be triggered by snapshot listener update 
                // because it will vanish from 'sharedNotes' list.
            } catch (error) {
                console.error("Error leaving note", error);
                showModal({ title: "Error", message: "Failed to leave note.", confirmText: "OK" });
            }
        }
    });
};

// Close suggestions on outside click
document.addEventListener('click', (e) => {
    if (!suggestionBox.classList.contains('hidden')) {
        // If clicking editor, we might need to keep it open unless handled by keyup?
        // But clicking elsewhere in editor usually means we want to close current suggestion list 
        // because context (cursor pos) changed.
        if (!suggestionBox.contains(e.target) && e.target !== noteContentInput) {
            hideSuggestions();
        }
    }
});

// Image Context Menu Logic
function updateImageMenuValues() {
    if (!selectedImage) return;
    
    // Width
    const w = parseInt(window.getComputedStyle(selectedImage).width);
    document.getElementById('img-width-input').value = w;
    
    // Height
    const h = parseInt(window.getComputedStyle(selectedImage).height);
    document.getElementById('img-height-input').value = h;
}

// Width Control
const imgWidthInput = document.getElementById('img-width-input');
const imgWidthInc = document.getElementById('img-width-inc');
const imgWidthDec = document.getElementById('img-width-dec');

function setImgWidth(val) {
    if (!selectedImage) return;
    selectedImage.style.width = val + 'px';
    // Auto adjust height to keep aspect ratio?
    // User requested separate control, but usually aspect ratio is desired.
    // Standard HTML behavior if height is not set is auto.
    // But if we set height explicitly before, we might skew it.
    // For now, respect the requested "Gives the option to adjust the width... Height... in similar manner"
    // implying independent control or at least manual control.
    updateResizerPosition();
    handleInput();
}

imgWidthInput.addEventListener('change', (e) => setImgWidth(e.target.value));
imgWidthInc.addEventListener('click', (e) => {
    e.stopPropagation(); // Keep menu open?
    imgWidthInput.value = parseInt(imgWidthInput.value) + 10;
    setImgWidth(imgWidthInput.value);
});
imgWidthDec.addEventListener('click', (e) => {
    e.stopPropagation();
    imgWidthInput.value = Math.max(10, parseInt(imgWidthInput.value) - 10);
    setImgWidth(imgWidthInput.value);
});

// Height Control
const imgHeightInput = document.getElementById('img-height-input');
const imgHeightInc = document.getElementById('img-height-inc');
const imgHeightDec = document.getElementById('img-height-dec');

function setImgHeight(val) {
    if (!selectedImage) return;
    selectedImage.style.height = val + 'px';
    updateResizerPosition();
    handleInput();
}

imgHeightInput.addEventListener('change', (e) => setImgHeight(e.target.value));
imgHeightInc.addEventListener('click', (e) => {
    e.stopPropagation();
    imgHeightInput.value = parseInt(imgHeightInput.value) + 10;
    setImgHeight(imgHeightInput.value);
});
imgHeightDec.addEventListener('click', (e) => {
    e.stopPropagation();
    imgHeightInput.value = Math.max(10, parseInt(imgHeightInput.value) - 10);
    setImgHeight(imgHeightInput.value);
});

// Helper Actions & Alignment
document.querySelectorAll('#image-context-menu .menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
        const action = item.getAttribute('data-action');
        if (!action) return;
        
        if (selectedImage) {
            if (action === 'img-reset') {
                selectedImage.style.width = '';
                selectedImage.style.height = '';
                selectedImage.style.verticalAlign = 'bottom';
                updateResizerPosition();
            }
            else if (action === 'imgalign-top') {
                selectedImage.style.verticalAlign = 'top';
            }
            else if (action === 'imgalign-middle') {
                selectedImage.style.verticalAlign = 'middle';
            }
            else if (action === 'imgalign-bottom') {
                selectedImage.style.verticalAlign = 'baseline'; // Changed to 'baseline' to sit on text line
            }
            handleInput();
        }
        
        imageContextMenu.classList.add('hidden');
    });
});


// Close suggestions on outside click
document.addEventListener('click', (e) => {
    if (!suggestionBox.classList.contains('hidden')) {
        // If clicking editor, we might need to keep it open unless handled by keyup?
        // But clicking elsewhere in editor usually means we want to close current suggestion list 
        // because context (cursor pos) changed.
        if (!suggestionBox.contains(e.target) && e.target !== noteContentInput) {
            hideSuggestions();
        } else if (e.target === noteContentInput) {
             // Clicking inside editor also usually invalidates the current suggestion popup position/context
             // unless we want to be very smart.
             // Standard behavior: close it.
             hideSuggestions();
        }
    }
});
