const HOST_TOKEN_KEY = "quiz-live:host-token";
const PLAYER_KEY = "quiz-live:player";
const IMAGE_BUCKET = "question-images";
const MAX_QUESTIONS = 20;
const ANSWER_COLORS = ["Rouge", "Bleu", "Jaune", "Vert"];

const state = {
  supabase: null,
  subscriptions: [],
  hostToken: localStorage.getItem(HOST_TOKEN_KEY) || crypto.randomUUID(),
  player: loadJson(PLAYER_KEY, null),
  adminAccess: false,
  editingQuestion: null,
  questionSaving: false,
};

localStorage.setItem(HOST_TOKEN_KEY, state.hostToken);

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmForm = document.querySelector("#confirm-form");
const confirmMessage = document.querySelector("#confirm-message");
let confirmHandler = null;

init();

function init() {
  localStorage.removeItem("quiz-live:admin-access");
  connectSupabase();
  bindGlobalEvents();
  window.addEventListener("hashchange", render);
  render();
}

function bindGlobalEvents() {
  confirmForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const accepted = event.submitter?.value === "yes";
    confirmDialog.close();
    if (accepted && confirmHandler) confirmHandler();
    confirmHandler = null;
  });
}

function connectSupabase() {
  const config = window.QUIZ_SUPABASE_CONFIG;
  const url = config?.url;
  const key = config?.publishableKey;

  if (!url || !key || key.includes("REMPLACE_MOI") || !window.supabase) {
    state.supabase = null;
    return;
  }

  state.supabase = window.supabase.createClient(url, key);
}

function render() {
  unsubscribeAll();
  const route = location.hash.replace(/^#\/?/, "") || "home";
  const [page, param] = route.split("/");

  if (page === "host" && param) return renderHostQuiz(param);
  if (page === "host") return renderHost();
  if (page === "admin") return renderAdminGate();
  if (page === "join") return renderHome();
  if (page === "play") return renderPlay(param);
  if (page === "session") return renderLiveSession(param);
  return renderHome();
}

function renderHome() {
  app.innerHTML = `
    <section class="join-screen">
      <form class="join-card form-grid" id="join-form" aria-label="Rejoindre une partie">
        <label class="field">
          <span>Code de la partie</span>
          <input name="code" maxlength="6" required placeholder="482913" inputmode="numeric" autocomplete="off" />
        </label>
        <label class="field">
          <span>Pseudo</span>
          <input name="nickname" maxlength="32" required placeholder="Ton pseudo" autocomplete="nickname" />
        </label>
        <button class="primary-button big-button" type="submit">Rejoindre</button>
      </form>
    </section>
  `;

  document.querySelector("#join-form").addEventListener("submit", joinGame);
}

function renderAdminGate() {
  if (state.adminAccess) {
    location.hash = "#/host";
    return;
  }

  app.innerHTML = `
    <section class="join-screen">
      <a class="back-link" href="#/" aria-label="Retour a l'accueil">&larr; Retour</a>
      <form class="join-card form-grid" id="admin-form">
        <div class="join-heading">
          <p class="eyebrow">Acces admin</p>
          <h1>Code admin</h1>
        </div>
        ${connectionNotice()}
        <label class="field">
          <span>Code d'administration</span>
          <input name="admin_code" required minlength="4" maxlength="80" placeholder="Code secret" autocomplete="off" type="password" />
        </label>
        <button class="primary-button big-button" type="submit" ${disabledIfOffline()}>Entrer</button>
      </form>
    </section>
  `;

  document.querySelector("#admin-form").addEventListener("submit", verifyAdminCode);
}

async function verifyAdminCode(event) {
  event.preventDefault();
  if (!requireSupabase()) return;

  const form = new FormData(event.currentTarget);
  const code = String(form.get("admin_code") || "").trim();
  const { data, error } = await state.supabase.rpc("verify_admin_code", { admin_code_input: code });

  if (error) return showToast(error.message);
  if (!data) return showToast("Code admin incorrect.");

  state.adminAccess = true;
  showToast("Acces admin valide.");
  location.hash = "#/host";
}

async function renderHost() {
  if (!state.adminAccess) return redirectHome();

  app.innerHTML = `
    <section class="page">
      <div class="page-title">
        <div>
          <p class="eyebrow">Admin</p>
          <h1>Studio quiz</h1>
          <p>Prepare les questions, lance une session, puis partage le code aux joueurs.</p>
        </div>
      </div>
      ${connectionNotice()}
      <div class="split">
        <form class="panel form-grid" id="quiz-form">
          <label class="field">
            <span>Titre du quiz</span>
            <input name="title" maxlength="90" required placeholder="Culture generale du vendredi" />
          </label>
          <label class="field">
            <span>Description</span>
            <textarea name="description" maxlength="260" placeholder="Une courte description pour retrouver le quiz"></textarea>
          </label>
          <button class="primary-button" type="submit" ${disabledIfOffline()}>Creer le quiz</button>
        </form>
        <div class="panel">
          <div class="status-strip">
            <strong>Mes quiz</strong>
            <button class="secondary-button" type="button" data-action="refresh-quizzes">Rafraichir</button>
          </div>
          <div class="list" id="quiz-list"></div>
        </div>
      </div>
    </section>
  `;

  document.querySelector("#quiz-form").addEventListener("submit", createQuiz);
  document.querySelector("[data-action='refresh-quizzes']").addEventListener("click", loadQuizzes);
  await loadQuizzes();
}

async function createQuiz(event) {
  event.preventDefault();
  if (!requireSupabase()) return;

  const form = new FormData(event.currentTarget);
  const payload = {
    title: String(form.get("title")).trim(),
    description: String(form.get("description") || "").trim(),
    host_token: state.hostToken,
  };

  const { data, error } = await state.supabase.from("quizzes").insert(payload).select("id").single();
  if (error) return showToast(error.message);

  showToast("Quiz cree.");
  location.hash = `#/host/${data.id}`;
}

async function loadQuizzes() {
  const list = document.querySelector("#quiz-list");
  if (!state.supabase) {
    list.innerHTML = `<div class="empty-state">Connecte Supabase pour charger tes quiz.</div>`;
    return;
  }

  const { data, error } = await state.supabase
    .from("quizzes")
    .select("id,title,description,created_at")
    .eq("host_token", state.hostToken)
    .order("created_at", { ascending: false });

  if (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  list.innerHTML = data.length
    ? data.map((quiz) => `
      <article class="question-card">
        <header>
          <strong>${escapeHtml(quiz.title)}</strong>
          <div class="quiz-actions">
            <span class="muted">${new Date(quiz.created_at).toLocaleDateString("fr-FR")}</span>
            <button class="icon-button" type="button" aria-label="Actions du quiz" data-action="toggle-quiz-actions" data-quiz-id="${quiz.id}">...</button>
          </div>
        </header>
        <p class="muted">${escapeHtml(quiz.description || "Sans description")}</p>
        <div class="row-actions quiz-menu hidden" data-quiz-menu="${quiz.id}">
          <a class="primary-button" href="#/host/${quiz.id}">Modifier</a>
          <button class="secondary-button" type="button" data-action="confirm-start-session" data-quiz-id="${quiz.id}" data-quiz-title="${escapeHtml(quiz.title)}">Lancer</button>
          <button class="danger-button" type="button" data-action="delete-quiz" data-quiz-id="${quiz.id}" data-quiz-title="${escapeHtml(quiz.title)}">Supprimer</button>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">Aucun quiz pour l'instant.</div>`;
}

async function deleteQuiz(quizId) {
  if (!requireSupabase()) return;

  const { error } = await state.supabase.from("quizzes").delete().eq("id", quizId);
  if (error) return showToast(error.message);

  showToast("Quiz supprime.");
  await loadQuizzes();
}

async function renderHostQuiz(quizId) {
  if (!state.adminAccess) return redirectHome();
  if (!quizId) return renderHost();

  app.innerHTML = `
    <section class="page">
      <div class="page-title">
        <div>
          <p class="eyebrow">Admin</p>
          <h1>Questions</h1>
          <p>Ajoute les reponses, choisis la bonne, puis lance une session.</p>
        </div>
        <a class="secondary-button" href="#/host">Retour</a>
      </div>
      ${connectionNotice()}
      <div class="split">
        <form class="panel form-grid" id="question-form">
          <div>
            <p class="eyebrow" id="question-form-mode">Nouvelle question</p>
            <h2>Ajouter une question</h2>
            <p class="muted compact">Chaque question peut avoir sa propre image. Tu peux ensuite la modifier ou la supprimer dans la liste.</p>
          </div>
          <label class="field">
            <span>Type de question</span>
            <select name="question_type" data-action="change-question-type">
              <option value="multiple_choice">Question a choix</option>
              <option value="free_text">Reponse libre</option>
              <option value="image_reveal">Image progressive</option>
            </select>
          </label>
          <label class="field">
            <span>Question</span>
            <textarea name="question" required maxlength="280" placeholder="Quelle est la capitale de... ?"></textarea>
          </label>
          <label class="field">
            <span>Image de la question</span>
            <input name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
          </label>
          <div class="choice-settings">
            <label class="field">
              <span>Nombre de reponses</span>
              <select name="answer_count" data-action="change-answer-count">
                <option value="2">2 reponses</option>
                <option value="3">3 reponses</option>
                <option value="4" selected>4 reponses</option>
                <option value="5">5 reponses</option>
                <option value="6">6 reponses</option>
              </select>
            </label>
          </div>
          <div id="answer-fields" class="form-grid choice-settings">
          ${[0, 1, 2, 3, 4, 5].map((index) => `
            <label class="field answer-field" data-answer-field="${index}">
              <span>Reponse ${index + 1}</span>
              <input name="answer_${index}" maxlength="120" placeholder="${ANSWER_COLORS[index] || `Choix ${index + 1}`}" />
            </label>
          `).join("")}
          </div>
          <label class="field choice-settings">
            <span>Bonne reponse</span>
            <select name="correct_index">
              <option value="0">Reponse 1</option>
              <option value="1">Reponse 2</option>
              <option value="2">Reponse 3</option>
              <option value="3">Reponse 4</option>
              <option value="4">Reponse 5</option>
              <option value="5">Reponse 6</option>
            </select>
          </label>
          <label class="field">
            <span>Temps de reponse</span>
            <input name="duration" type="number" min="8" max="90" value="20" required />
          </label>
          <div class="mini-grid">
            <label class="field">
              <span>Points minimum</span>
              <input name="min_points" type="number" min="0" max="100000" value="50" required />
            </label>
            <label class="field">
              <span>Points maximum</span>
              <input name="max_points" type="number" min="0" max="100000" value="100" required />
            </label>
          </div>
          <button class="primary-button" type="submit" ${disabledIfOffline()}>Ajouter</button>
          <button class="secondary-button hidden" type="button" data-action="cancel-question-edit">Annuler la modification</button>
        </form>
        <div class="panel">
          <div class="status-strip">
            <div>
              <strong id="quiz-name">Quiz</strong>
              <p class="muted compact" id="question-count">0/${MAX_QUESTIONS} questions</p>
            </div>
            <button class="primary-button" type="button" data-action="start-session" ${disabledIfOffline()}>Lancer</button>
          </div>
          <p class="muted compact">Liste des questions. Utilise les boutons pour modifier ou supprimer une question precise.</p>
          <div class="question-editor" id="question-list"></div>
        </div>
      </div>
    </section>
  `;

  document.querySelector("#question-form").addEventListener("submit", (event) => createQuestion(event, quizId));
  document.querySelector("[data-action='change-question-type']").addEventListener("change", updateQuestionTypeFields);
  document.querySelector("[data-action='change-answer-count']").addEventListener("change", updateAnswerFields);
  document.querySelector("[data-action='start-session']").addEventListener("click", () => {
    askConfirmation("Vous etes sur de lancer ce quizz ?", () => startSession(quizId));
  });
  updateQuestionTypeFields();
  updateAnswerFields();
  await Promise.all([loadQuizTitle(quizId), loadQuestions(quizId)]);
}

async function loadQuizTitle(quizId) {
  if (!state.supabase) return;
  const { data } = await state.supabase.from("quizzes").select("title").eq("id", quizId).single();
  if (data) document.querySelector("#quiz-name").textContent = data.title;
}

function updateQuestionTypeFields() {
  const form = document.querySelector("#question-form");
  if (!form) return;

  const type = form.elements.question_type.value;
  const isFreeText = type === "free_text";
  form.querySelectorAll(".choice-settings").forEach((node) => node.classList.toggle("hidden", isFreeText));
  form.elements.image.closest(".field").querySelector("span").textContent = type === "image_reveal"
    ? "Image a faire deviner"
    : "Image de la question";
  updateAnswerFields();
}

function updateAnswerFields() {
  const form = document.querySelector("#question-form");
  if (!form) return;

  const type = form.elements.question_type.value;
  const count = type === "free_text" ? 0 : Number(form.elements.answer_count.value || 4);
  form.querySelectorAll("[data-answer-field]").forEach((field) => {
    const index = Number(field.dataset.answerField);
    const visible = index < count;
    field.classList.toggle("hidden", !visible);
    field.querySelector("input").required = visible;
  });

  [...form.elements.correct_index.options].forEach((option, index) => {
    option.hidden = index >= count;
  });
  if (Number(form.elements.correct_index.value) >= count) form.elements.correct_index.value = "0";
}

async function createQuestion(event, quizId) {
  event.preventDefault();
  if (!requireSupabase()) return;
  if (state.questionSaving) return;

  state.questionSaving = true;
  setQuestionSaving(true);
  const form = new FormData(event.currentTarget);
  try {
    const editing = state.editingQuestion;
    const { count } = editing
      ? { count: 0 }
      : await state.supabase
        .from("questions")
        .select("id", { count: "exact", head: true })
        .eq("quiz_id", quizId);

    if (!editing && (count || 0) >= MAX_QUESTIONS) {
      showToast(`Un quiz ne peut pas depasser ${MAX_QUESTIONS} questions.`);
      return;
    }

    const imageFile = form.get("image");
    const imageUrl = imageFile?.size ? await uploadQuestionImage(quizId, imageFile) : null;
    if (imageFile?.size && !imageUrl) return;
    const questionType = String(form.get("question_type") || "multiple_choice");
    const answerCount = questionType === "free_text" ? 0 : Number(form.get("answer_count") || 4);
    const answers = questionType === "free_text"
      ? []
      : Array.from({ length: answerCount }, (_, index) => String(form.get(`answer_${index}`)).trim());
    const minPoints = Number(form.get("min_points"));
    const maxPoints = Number(form.get("max_points"));
    if (maxPoints < minPoints) {
      showToast("Les points maximum doivent etre superieurs aux points minimum.");
      return;
    }

    const payload = {
      question_type: questionType,
      body: String(form.get("question")).trim(),
      answers,
      image_url: imageUrl || editing?.image_url || null,
      correct_index: questionType === "free_text" ? 0 : Number(form.get("correct_index")),
      duration_seconds: Number(form.get("duration")),
      min_points: minPoints,
      max_points: maxPoints,
    };

    const query = editing
      ? state.supabase.from("questions").update(payload).eq("id", editing.id)
      : state.supabase.from("questions").insert({ ...payload, quiz_id: quizId, position: count || 0 });

    const { error } = await query;
    if (error) return showToast(error.message);

    state.editingQuestion = null;
    event.currentTarget.reset();
    setQuestionFormMode(null);
    showToast(editing ? "Question modifiee." : "Question ajoutee.");
    await loadQuestions(quizId);
  } finally {
    state.questionSaving = false;
    setQuestionSaving(false);
  }
}

async function uploadQuestionImage(quizId, file) {
  if (!file.type.startsWith("image/")) {
    showToast("Le fichier doit etre une image.");
    return null;
  }

  if (file.size > 5 * 1024 * 1024) {
    showToast("Image trop lourde : maximum 5 Mo.");
    return null;
  }

  const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const safeExtension = extension.replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${quizId}/${crypto.randomUUID()}.${safeExtension}`;
  const { error } = await state.supabase.storage.from(IMAGE_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });

  if (error) {
    showToast(error.message);
    return null;
  }

  const { data } = state.supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function setQuestionFormMode(question) {
  const form = document.querySelector("#question-form");
  if (!form) return;

  const submitButton = form.querySelector("button[type='submit']");
  const cancelButton = form.querySelector("[data-action='cancel-question-edit']");
  const mode = form.querySelector("#question-form-mode");
  const title = form.querySelector("h2");
  submitButton.textContent = question ? "Enregistrer" : "Ajouter";
  cancelButton.classList.toggle("hidden", !question);
  if (mode) mode.textContent = question ? "Modification" : "Nouvelle question";
  if (title) title.textContent = question ? "Modifier cette question" : "Ajouter une question";
}

function setQuestionSaving(isSaving) {
  const form = document.querySelector("#question-form");
  if (!form) return;

  const submitButton = form.querySelector("button[type='submit']");
  const cancelButton = form.querySelector("[data-action='cancel-question-edit']");
  submitButton.disabled = isSaving;
  submitButton.textContent = isSaving ? "Enregistrement..." : (state.editingQuestion ? "Enregistrer" : "Ajouter");
  cancelButton.disabled = isSaving;
}

function editQuestion(questionId) {
  const question = state.questions?.find((item) => item.id === questionId);
  const form = document.querySelector("#question-form");
  if (!question || !form) return;

  state.editingQuestion = question;
  form.elements.question_type.value = question.question_type || "multiple_choice";
  form.elements.question.value = question.body;
  form.elements.answer_count.value = String(Math.max(2, question.answers?.length || 4));
  updateQuestionTypeFields();
  question.answers.forEach((answer, index) => {
    form.elements[`answer_${index}`].value = answer;
  });
  form.elements.correct_index.value = String(question.correct_index);
  form.elements.duration.value = String(question.duration_seconds);
  form.elements.min_points.value = String(question.min_points ?? 50);
  form.elements.max_points.value = String(question.max_points ?? 100);
  form.elements.image.value = "";
  setQuestionFormMode(question);
  form.querySelector("button[type='submit']").disabled = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteQuestion(questionId, quizId) {
  if (!requireSupabase()) return;

  const { error } = await state.supabase.from("questions").delete().eq("id", questionId);
  if (error) return showToast(error.message);

  if (state.editingQuestion?.id === questionId) {
    state.editingQuestion = null;
    document.querySelector("#question-form")?.reset();
    setQuestionFormMode(null);
  }

  showToast("Question supprimee.");
  await resequenceQuestions(quizId);
  await loadQuestions(quizId);
}

async function resequenceQuestions(quizId) {
  const { data, error } = await state.supabase
    .from("questions")
    .select("id")
    .eq("quiz_id", quizId)
    .order("position", { ascending: true });
  if (error) return;

  await Promise.all(data.map((question, index) => (
    state.supabase.from("questions").update({ position: index }).eq("id", question.id)
  )));
}

async function loadQuestions(quizId) {
  const list = document.querySelector("#question-list");
  if (!state.supabase) {
    list.innerHTML = `<div class="empty-state">Connecte Supabase pour ajouter des questions.</div>`;
    return;
  }

  const { data, error } = await state.supabase
    .from("questions")
    .select("*")
    .eq("quiz_id", quizId)
    .order("position", { ascending: true });

  if (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  state.questions = data;
  const countNode = document.querySelector("#question-count");
  const submitButton = document.querySelector("#question-form button[type='submit']");
  if (countNode) countNode.textContent = `${data.length}/${MAX_QUESTIONS} questions`;
  if (submitButton && !state.editingQuestion && !state.questionSaving) {
    submitButton.disabled = !state.supabase || data.length >= MAX_QUESTIONS;
    submitButton.textContent = data.length >= MAX_QUESTIONS ? "Limite atteinte" : "Ajouter";
  }

  list.innerHTML = data.length
    ? data.map((question, index) => `
      <article class="question-card">
        <header>
          <strong>${index + 1}. ${escapeHtml(question.body)}</strong>
          <span class="pin">${questionTypeLabel(question)} · ${question.duration_seconds}s</span>
        </header>
        ${question.image_url ? `<img class="question-image-thumb" src="${escapeHtml(question.image_url)}" alt="Image de la question ${index + 1}" />` : ""}
        <p class="muted compact">Points bonne reponse : ${question.min_points ?? 50} a ${question.max_points ?? 100}</p>
        <p class="muted">${question.question_type === "free_text" ? "Reponse libre avec graphique des reponses" : question.answers.map((answer, answerIndex) => answerIndex === question.correct_index ? `✓ ${answer}` : answer).map(escapeHtml).join(" / ")}</p>
        <div class="row-actions">
          <button class="secondary-button" type="button" data-action="edit-question" data-question-id="${question.id}">Modifier</button>
          <button class="danger-button" type="button" data-action="delete-question" data-question-id="${question.id}" data-quiz-id="${quizId}">Supprimer</button>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">Ajoute au moins une question avant de lancer la partie.</div>`;
}

function questionTypeLabel(question) {
  if (question.question_type === "free_text") return "Libre";
  if (question.question_type === "image_reveal") return "Image progressive";
  return `${question.answers?.length || 4} choix`;
}

async function startSession(quizId) {
  if (!requireSupabase()) return;

  const { data: questions, error: questionError } = await state.supabase
    .from("questions")
    .select("id")
    .eq("quiz_id", quizId)
    .limit(1);

  if (questionError) return showToast(questionError.message);
  if (!questions.length) return showToast("Ajoute au moins une question.");

  const payload = {
    quiz_id: quizId,
    code: await generateAvailableCode(),
    host_token: state.hostToken,
    status: "lobby",
    access_enabled: true,
    current_question_index: -1,
  };

  const { data, error } = await state.supabase.from("game_sessions").insert(payload).select("id,code").single();
  if (error) return showToast(error.message);

  showToast(`Session ${data.code} lancee.`);
  location.hash = `#/session/${data.id}`;
}

async function renderLiveSession(sessionId) {
  if (!state.adminAccess) return redirectHome();
  if (!sessionId) return renderHost();

  app.innerHTML = `
    <section class="page">
      <div class="page-title">
        <div>
          <p class="eyebrow">Live admin</p>
          <h1 id="session-title">Session</h1>
          <p>Le code s'affiche aux joueurs, puis chaque question avance au rythme de l'admin.</p>
        </div>
        <button class="secondary-button" type="button" data-action="quit-session">Quitter</button>
      </div>
      ${connectionNotice()}
      <div class="split">
        <div class="panel">
          <p class="eyebrow">Code partie</p>
          <div class="game-code" id="game-code">----</div>
          <div class="row-actions">
            <button class="primary-button" type="button" data-action="start-live-game" ${disabledIfOffline()}>Demarrer</button>
            <button class="primary-button hidden" type="button" data-action="continue-live-game" ${disabledIfOffline()}>Continuer</button>
            <button class="secondary-button" type="button" data-action="set-session-access" data-session-id="${sessionId}" data-enabled="false" ${disabledIfOffline()}>Bloquer les entrees</button>
            <button class="secondary-button" type="button" data-action="set-session-access" data-session-id="${sessionId}" data-enabled="true" ${disabledIfOffline()}>Rouvrir les entrees</button>
            <button class="danger-button" type="button" data-action="end-session" ${disabledIfOffline()}>Close</button>
          </div>
        </div>
        <div class="panel">
          <div class="status-strip">
            <strong>Joueurs et scores</strong>
            <span class="pin" id="session-status">Lobby</span>
          </div>
          <div class="list" id="player-list"></div>
        </div>
      </div>
      <div class="panel" id="live-question"></div>
    </section>
  `;

  document.querySelector("[data-action='start-live-game']").addEventListener("click", () => startLiveGame(sessionId));
  document.querySelector("[data-action='continue-live-game']").addEventListener("click", () => continueLiveGame(sessionId));
  document.querySelector("[data-action='end-session']").addEventListener("click", () => endSession(sessionId));
  document.querySelector("[data-action='quit-session']").addEventListener("click", async () => {
    await endSession(sessionId);
    location.hash = "#/host";
  });
  await refreshHostLive(sessionId);
  subscribeSession(sessionId, () => refreshHostLive(sessionId));
}

async function refreshHostLive(sessionId) {
  if (!state.supabase) return;

  const { data: session, error } = await state.supabase
    .from("game_sessions")
    .select("*, quizzes(title, questions(*))")
    .eq("id", sessionId)
    .single();

  if (error) return showToast(error.message);

  const questions = [...(session.quizzes?.questions || [])].sort((a, b) => a.position - b.position);
  const current = questions[session.current_question_index];
  document.querySelector("#session-title").textContent = session.quizzes?.title || "Session";
  document.querySelector("#game-code").textContent = session.code;
  document.querySelector("#session-status").textContent = `${session.status} - ${session.access_enabled ? "entrees ouvertes" : "entrees bloquees"}`;
  updateLiveControls(session);

  await renderPlayers(sessionId);
  renderLiveQuestion(current, session);
}

function updateLiveControls(session) {
  const startButton = document.querySelector("[data-action='start-live-game']");
  const continueButton = document.querySelector("[data-action='continue-live-game']");
  const accessButtons = document.querySelectorAll("[data-action='set-session-access']");

  startButton?.classList.toggle("hidden", session.status !== "lobby");
  continueButton?.classList.toggle("hidden", session.status !== "playing");
  accessButtons.forEach((button) => button.classList.toggle("hidden", session.status !== "lobby"));
}

async function renderPlayers(sessionId) {
  const list = document.querySelector("#player-list");
  const { data, error } = await state.supabase
    .from("game_players")
    .select("id,nickname,score,joined_at")
    .eq("session_id", sessionId)
    .order("score", { ascending: false });

  if (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  list.innerHTML = data.length
    ? data.map((player, index) => `
      <div class="score-row">
        <strong>${index + 1}. ${escapeHtml(player.nickname)}</strong>
        <div class="player-actions">
          <span class="pin">${player.score} pts</span>
          <button class="icon-button danger-icon" type="button" aria-label="Faire quitter ${escapeHtml(player.nickname)}" data-action="kick-player" data-player-id="${player.id}">x</button>
        </div>
      </div>
    `).join("")
    : `<div class="empty-state">En attente des joueurs.</div>`;
}

function renderLiveQuestion(question, session) {
  const node = document.querySelector("#live-question");
  if (session.status === "finished") {
    renderFinalScores(session.id, node);
    return;
  }

  if (session.show_leaderboard) {
    question?.question_type === "free_text" ? renderFreeTextChart(session.id, question.id, node) : renderLeaderboard(session.id, node);
    return;
  }

  if (!question) {
    node.innerHTML = `<div class="empty-state">La partie est dans le lobby. Lance la premiere question.</div>`;
    return;
  }

  node.innerHTML = `
    <p class="eyebrow">Question ${session.current_question_index + 1}</p>
    <h2>${escapeHtml(question.body)}</h2>
    ${renderQuestionImage(question, session)}
    ${question.question_type === "free_text" ? `<div class="empty-state">Les joueurs ecrivent une reponse libre.</div>` : ""}
    <div class="answer-grid">
      ${question.question_type === "free_text" ? "" : question.answers.map((answer, index) => `
        <div class="answer-tile ${session.show_answer && index === question.correct_index ? "is-correct-answer" : ""}">
          ${session.show_answer && index === question.correct_index ? `<span class="answer-badge">Bonne reponse</span>` : ""}
          ${escapeHtml(answer)}
        </div>
      `).join("")}
    </div>
  `;
}

function renderQuestionImage(question, session) {
  if (!question.image_url) return "";
  if (question.question_type !== "image_reveal") {
    return `<img class="question-live-image" src="${escapeHtml(question.image_url)}" alt="Image de la question" />`;
  }

  const order = [4, 0, 8, 2, 6, 1, 7, 3, 5];
  const revealed = session.show_answer ? 9 : getRevealedTileCount(session);
  const cells = order.map((cellIndex, step) => {
    if (step < revealed) return "";
    const delay = Math.max(0, step + 1 - revealed);
    return `<span class="reveal-tile" data-cell="${cellIndex}" style="--delay: ${delay}s"></span>`;
  }).join("");

  return `
    <div class="image-reveal">
      <img class="question-live-image" src="${escapeHtml(question.image_url)}" alt="Image de la question" />
      <div class="reveal-grid" aria-hidden="true">${cells}</div>
    </div>
  `;
}

function getRevealedTileCount(session) {
  if (!session.question_started_at) return 0;
  const elapsed = Math.floor((Date.now() - new Date(session.question_started_at).getTime()) / 1000);
  return Math.max(0, Math.min(9, elapsed));
}

async function renderLeaderboard(sessionId, container = document.querySelector("#live-question")) {
  const { data, error } = await state.supabase
    .from("game_players")
    .select("nickname,score")
    .eq("session_id", sessionId)
    .order("score", { ascending: false })
    .limit(10);

  if (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  container.innerHTML = `
    <p class="eyebrow">Classement</p>
    <h2>Top 10</h2>
    <div class="leaderboard-list">
      ${data.length ? data.map((player, index) => `
        <div class="score-row leaderboard-row">
          <strong>${index + 1}. ${escapeHtml(player.nickname)}</strong>
          <span class="pin">${player.score} pts</span>
        </div>
      `).join("") : `<div class="empty-state">Aucun score pour l'instant.</div>`}
    </div>
  `;
}

async function renderFreeTextChart(sessionId, questionId, container = document.querySelector("#live-question")) {
  const { data, error } = await state.supabase
    .from("game_answers")
    .select("answer_text")
    .eq("session_id", sessionId)
    .eq("question_id", questionId);

  if (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  const counts = new Map();
  data.forEach((row) => {
    const answer = normalizeFreeAnswer(row.answer_text);
    if (!answer) return;
    counts.set(answer, (counts.get(answer) || 0) + 1);
  });

  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  container.innerHTML = `
    <p class="eyebrow">Reponses libres</p>
    <h2>Graphique des reponses</h2>
    <div class="chart-list">
      ${rows.length ? rows.map(([answer, count]) => {
        const percent = total ? Math.round((count / total) * 100) : 0;
        return `
          <div class="chart-row">
            <div class="chart-label">
              <strong>${escapeHtml(answer)}</strong>
              <span>${percent}% · ${count}</span>
            </div>
            <div class="chart-track"><span style="width: ${percent}%"></span></div>
          </div>
        `;
      }).join("") : `<div class="empty-state">Aucune reponse recue.</div>`}
    </div>
  `;
}

function normalizeFreeAnswer(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80).toLowerCase();
}

async function startLiveGame(sessionId) {
  if (!requireSupabase()) return;

  const { data: session, error } = await state.supabase
    .from("game_sessions")
    .select("id,quiz_id,current_question_index,status")
    .eq("id", sessionId)
    .single();
  if (error) return showToast(error.message);
  if (session.status === "finished") return showToast("Cette partie est fermee.");
  if (session.current_question_index >= 0) return showToast("La partie a deja demarre.");

  const { count } = await state.supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", session.quiz_id);
  if (!count) return showToast("Ajoute au moins une question.");

  const { error: updateError } = await state.supabase
    .from("game_sessions")
    .update({ current_question_index: 0, status: "playing", access_enabled: false, show_answer: false, show_leaderboard: false, question_started_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (updateError) return showToast(updateError.message);

  showToast("Partie demarree.");
}

async function continueLiveGame(sessionId) {
  if (!requireSupabase()) return;

  const { data: session, error } = await state.supabase
    .from("game_sessions")
    .select("id,quiz_id,current_question_index,status,show_answer,show_leaderboard")
    .eq("id", sessionId)
    .single();
  if (error) return showToast(error.message);
  if (session.status !== "playing") return;

  const { count } = await state.supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", session.quiz_id);

  if (!session.show_answer) {
    const { error: updateError } = await state.supabase
      .from("game_sessions")
      .update({ show_answer: true })
      .eq("id", sessionId);
    if (updateError) return showToast(updateError.message);
    return;
  }

  if (!session.show_leaderboard) {
    const { error: updateError } = await state.supabase
      .from("game_sessions")
      .update({ show_leaderboard: true })
      .eq("id", sessionId);
    if (updateError) return showToast(updateError.message);
    return;
  }

  const nextIndex = session.current_question_index + 1;
  if (nextIndex >= count) return endSession(sessionId);

  const { error: updateError } = await state.supabase
    .from("game_sessions")
    .update({ current_question_index: nextIndex, status: "playing", show_answer: false, show_leaderboard: false, question_started_at: new Date().toISOString() })
    .eq("id", sessionId);

  if (updateError) return showToast(updateError.message);
}

async function endSession(sessionId) {
  if (!requireSupabase()) return;
  const { error } = await state.supabase
    .from("game_sessions")
    .update({ status: "finished", access_enabled: false, show_answer: false, show_leaderboard: false })
    .eq("id", sessionId);
  if (error) return showToast(error.message);
  showToast("Partie terminee.");
}

async function setSessionAccess(sessionId, enabled) {
  if (!requireSupabase()) return;
  const { error } = await state.supabase
    .from("game_sessions")
    .update({ access_enabled: enabled })
    .eq("id", sessionId)
    .neq("status", "finished");
  if (error) return showToast(error.message);
  showToast(enabled ? "Entrees rouvertes." : "Entrees bloquees.");
}

async function kickPlayer(playerId) {
  if (!requireSupabase()) return;
  const { error } = await state.supabase.from("game_players").delete().eq("id", playerId);
  if (error) return showToast(error.message);
  showToast("Joueur retire de la partie.");
}

async function joinGame(event) {
  event.preventDefault();
  if (!requireSupabase()) return;

  const form = new FormData(event.currentTarget);
  const code = String(form.get("code")).trim().toUpperCase();
  const nickname = String(form.get("nickname")).trim();

  const { data: session, error: sessionError } = await state.supabase
    .from("game_sessions")
    .select("id,status,access_enabled")
    .eq("code", code)
    .neq("status", "finished")
    .single();

  if (sessionError || !session) return showToast("Partie introuvable.");
  if (!session.access_enabled) return showToast("L'acces a cette partie est temporairement bloque.");

  const { data: player, error } = await state.supabase
    .from("game_players")
    .insert({ session_id: session.id, nickname, score: 0 })
    .select("id,session_id,nickname")
    .single();

  if (error) return showToast(error.message);

  state.player = player;
  localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  location.hash = `#/play/${session.id}`;
}

async function renderPlay(sessionId) {
  if (!state.player || state.player.session_id !== sessionId) return renderHome();

  app.innerHTML = `
    <section class="page">
      <div class="page-title">
        <div>
          <p class="eyebrow">Joueur</p>
          <h1>${escapeHtml(state.player.nickname)}</h1>
          <p id="player-status">Connexion a la partie...</p>
        </div>
      </div>
      ${connectionNotice()}
      <div class="panel" id="player-view"></div>
    </section>
  `;

  await refreshPlayerView(sessionId);
  subscribeSession(sessionId, () => refreshPlayerView(sessionId));
}

async function refreshPlayerView(sessionId) {
  if (!state.supabase) return;

  const { data: playerStillHere, error: playerError } = await state.supabase
    .from("game_players")
    .select("id")
    .eq("id", state.player.id)
    .maybeSingle();

  if (playerError) return showToast(playerError.message);
  if (!playerStillHere) {
    localStorage.removeItem(PLAYER_KEY);
    state.player = null;
    showToast("Tu as quitte la partie.");
    location.hash = "#/";
    return;
  }

  const { data: session, error } = await state.supabase
    .from("game_sessions")
    .select("*, quizzes(title, questions(*))")
    .eq("id", sessionId)
    .single();

  if (error) return showToast(error.message);

  const questions = [...(session.quizzes?.questions || [])].sort((a, b) => a.position - b.position);
  const question = questions[session.current_question_index];
  document.querySelector("#player-status").textContent = session.quizzes?.title || "Partie en cours";

  const view = document.querySelector("#player-view");
  if (session.status === "lobby") {
    view.innerHTML = `<div class="empty-state">Tu es dans le lobby. L'admin va bientot lancer la partie.</div>`;
    return;
  }

  if (session.status === "finished") {
    localStorage.removeItem(PLAYER_KEY);
    state.player = null;
    showToast("Le quiz est termine.");
    location.hash = "#/";
    return;
  }

  if (session.show_leaderboard) {
    await renderLeaderboard(sessionId, view);
    return;
  }

  if (!question) {
    view.innerHTML = `<div class="empty-state">En attente de la prochaine question.</div>`;
    return;
  }

  const { data: existing } = await state.supabase
    .from("game_answers")
    .select("id,answer_index,answer_text")
    .eq("session_id", sessionId)
    .eq("player_id", state.player.id)
    .eq("question_id", question.id)
    .maybeSingle();

  if (question.question_type === "free_text") {
    view.innerHTML = `
      <p class="eyebrow">Question ${session.current_question_index + 1}</p>
      <h2>${escapeHtml(question.body)}</h2>
      ${renderQuestionImage(question, session)}
      ${session.show_leaderboard ? "" : `
        <form class="form-grid" id="free-answer-form">
          <label class="field">
            <span>Ta reponse</span>
            <input name="answer_text" maxlength="120" required ${existing || session.show_answer ? "disabled" : ""} value="${escapeHtml(existing?.answer_text || "")}" />
          </label>
          <button class="primary-button" type="submit" ${existing || session.show_answer ? "disabled" : ""}>Envoyer</button>
        </form>
      `}
      ${existing && !session.show_leaderboard ? `<p class="muted compact">Reponse envoyee. En attente des resultats.</p>` : ""}
    `;
    view.querySelector("#free-answer-form")?.addEventListener("submit", (event) => submitFreeAnswer(event, sessionId, question));
    return;
  }

  view.innerHTML = `
    <p class="eyebrow">Question ${session.current_question_index + 1}</p>
    <h2>${escapeHtml(question.body)}</h2>
    ${renderQuestionImage(question, session)}
    <div class="choice-grid">
      ${question.answers.map((answer, index) => `
        <button class="answer-button ${existing?.answer_index === index ? "is-selected" : ""} ${session.show_answer && index === question.correct_index ? "is-correct-answer" : ""}" type="button" data-answer="${index}" ${existing || session.show_answer ? "disabled" : ""}>
          ${session.show_answer && index === question.correct_index ? `<span class="answer-badge">Bonne reponse</span>` : ""}
          ${escapeHtml(answer)}
        </button>
      `).join("")}
    </div>
    ${existing && !session.show_answer ? `<p class="muted compact">Reponse envoyee. En attente de la correction.</p>` : ""}
  `;

  view.querySelectorAll("[data-answer]").forEach((button) => {
    button.addEventListener("click", () => submitAnswer(sessionId, question, Number(button.dataset.answer)));
  });
}

async function submitAnswer(sessionId, question, answerIndex) {
  if (!requireSupabase()) return;

  const isCorrect = answerIndex === question.correct_index;
  const points = isCorrect ? await calculateTimedPoints(sessionId, question) : 0;
  const { error } = await state.supabase.from("game_answers").insert({
    session_id: sessionId,
    player_id: state.player.id,
    question_id: question.id,
    answer_index: answerIndex,
    is_correct: isCorrect,
    points,
  });

  if (error) return showToast(error.message);

  if (points > 0) {
    await state.supabase.rpc("increment_player_score", { player_id_input: state.player.id, points_input: points });
  }

  showToast("Reponse envoyee.");
  await refreshPlayerView(sessionId);
}

async function submitFreeAnswer(event, sessionId, question) {
  event.preventDefault();
  if (!requireSupabase()) return;

  const form = new FormData(event.currentTarget);
  const answerText = String(form.get("answer_text") || "").trim();
  if (!answerText) return;

  const { error } = await state.supabase.from("game_answers").insert({
    session_id: sessionId,
    player_id: state.player.id,
    question_id: question.id,
    answer_index: null,
    answer_text: answerText,
    is_correct: false,
    points: 0,
  });

  if (error) return showToast(error.message);
  showToast("Reponse envoyee.");
  await refreshPlayerView(sessionId);
}

async function calculateTimedPoints(sessionId, question) {
  const minPoints = Number(question.min_points ?? 50);
  const maxPoints = Number(question.max_points ?? 100);
  if (maxPoints <= minPoints) return minPoints;

  const { data: session, error } = await state.supabase
    .from("game_sessions")
    .select("question_started_at")
    .eq("id", sessionId)
    .single();
  if (error || !session?.question_started_at) return minPoints;

  const elapsedSeconds = Math.max(0, (Date.now() - new Date(session.question_started_at).getTime()) / 1000);
  const duration = Math.max(1, Number(question.duration_seconds || 20));
  const remainingRatio = Math.max(0, Math.min(1, 1 - elapsedSeconds / duration));
  return Math.round(minPoints + (maxPoints - minPoints) * remainingRatio);
}

async function renderFinalScores(sessionId, view) {
  const { data, error } = await state.supabase
    .from("game_players")
    .select("nickname,score")
    .eq("session_id", sessionId)
    .order("score", { ascending: false })
    .limit(10);

  if (error) {
    view.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  view.innerHTML = `
    <p class="eyebrow">Resultats</p>
    <h2>Le quiz est termine, voici le classement</h2>
    <div class="list">
      ${data.map((player, index) => `
        <div class="score-row">
          <strong>${index + 1}. ${escapeHtml(player.nickname)}</strong>
          <span class="pin">${player.score} pts</span>
        </div>
      `).join("")}
    </div>
  `;
}

async function generateAvailableCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const { data } = await state.supabase
      .from("game_sessions")
      .select("id")
      .eq("code", code)
      .neq("status", "finished")
      .maybeSingle();
    if (!data) return code;
  }
  return String(Date.now()).slice(-6);
}

function subscribeSession(sessionId, callback) {
  if (!state.supabase) return;

  let channel = state.supabase
    .channel(`session-${sessionId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "game_sessions", filter: `id=eq.${sessionId}` }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "game_players", filter: `session_id=eq.${sessionId}` }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "game_answers", filter: `session_id=eq.${sessionId}` }, callback);

  if (state.player?.session_id === sessionId) {
    channel = channel.on("postgres_changes", { event: "*", schema: "public", table: "game_players", filter: `id=eq.${state.player.id}` }, callback);
  }

  channel = channel.subscribe();

  state.subscriptions.push(channel);
}

function unsubscribeAll() {
  if (!state.supabase) return;
  state.subscriptions.forEach((channel) => state.supabase.removeChannel(channel));
  state.subscriptions = [];
}

function connectionNotice() {
  if (state.supabase) return "";
  return `
    <div class="status-strip">
      <strong>Supabase n'est pas encore configure.</strong>
      <span class="muted">Verifie le fichier supabase-config.js.</span>
    </div>
  `;
}

function disabledIfOffline() {
  return state.supabase ? "" : "disabled";
}

function requireSupabase() {
  if (state.supabase) return true;
  showToast("La configuration Supabase manque dans supabase-config.js.");
  return false;
}

function redirectHome() {
  showToast("Passe par l'accueil puis entre le code admin.");
  location.hash = "#/";
}

document.addEventListener("click", (event) => {
  if (event.target.matches("[data-action='toggle-quiz-actions']")) {
    const quizId = event.target.dataset.quizId;
    document.querySelector(`[data-quiz-menu="${quizId}"]`)?.classList.toggle("hidden");
  }
  if (event.target.matches("[data-action='confirm-start-session']")) {
    const quizId = event.target.dataset.quizId;
    const quizTitle = event.target.dataset.quizTitle || "ce quiz";
    askConfirmation(`Vous etes sur de lancer le quizz "${quizTitle}" ?`, () => startSession(quizId));
  }
  if (event.target.matches("[data-action='delete-quiz']")) {
    const quizId = event.target.dataset.quizId;
    const quizTitle = event.target.dataset.quizTitle || "ce quiz";
    askConfirmation(`Supprimer definitivement le quiz "${quizTitle}" ?`, () => deleteQuiz(quizId));
  }
  if (event.target.matches("[data-action='kick-player']")) {
    kickPlayer(event.target.dataset.playerId);
  }
  if (event.target.matches("[data-action='set-session-access']")) {
    setSessionAccess(event.target.dataset.sessionId, event.target.dataset.enabled === "true");
  }
  if (event.target.matches("[data-action='edit-question']")) {
    editQuestion(event.target.dataset.questionId);
  }
  if (event.target.matches("[data-action='delete-question']")) {
    const questionId = event.target.dataset.questionId;
    const quizId = event.target.dataset.quizId;
    askConfirmation("Supprimer cette question ?", () => deleteQuestion(questionId, quizId));
  }
  if (event.target.matches("[data-action='cancel-question-edit']")) {
    state.editingQuestion = null;
    document.querySelector("#question-form")?.reset();
    setQuestionFormMode(null);
  }
});

function askConfirmation(message, onConfirm) {
  confirmMessage.textContent = message;
  confirmHandler = onConfirm;
  confirmDialog.showModal();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
