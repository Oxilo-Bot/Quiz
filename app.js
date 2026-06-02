const CONFIG_KEY = "quiz-live:supabase-config";
const HOST_TOKEN_KEY = "quiz-live:host-token";
const PLAYER_KEY = "quiz-live:player";
const ADMIN_ACCESS_KEY = "quiz-live:admin-access";
const ANSWER_COLORS = ["Rouge", "Bleu", "Jaune", "Vert"];

const state = {
  supabase: null,
  config: loadConfig(),
  subscriptions: [],
  hostToken: localStorage.getItem(HOST_TOKEN_KEY) || crypto.randomUUID(),
  player: loadJson(PLAYER_KEY, null),
  adminAccess: localStorage.getItem(ADMIN_ACCESS_KEY) === "true",
};

localStorage.setItem(HOST_TOKEN_KEY, state.hostToken);

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const settingsDialog = document.querySelector("#settings-dialog");
const settingsForm = document.querySelector("#settings-form");

init();

function init() {
  connectSupabase();
  bindGlobalEvents();
  window.addEventListener("hashchange", render);
  render();
}

function bindGlobalEvents() {
  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      settingsDialog.close();
      return;
    }

    const form = new FormData(settingsForm);
    const url = String(form.get("url") || "").trim();
    const key = String(form.get("key") || "").trim();
    if (!url || !key) {
      showToast("Ajoute l'URL et l'anon key Supabase.");
      return;
    }

    state.config = { url, key };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    connectSupabase();
    settingsDialog.close();
    showToast("Supabase est connecte.");
    render();
  });
}

function connectSupabase() {
  if (!state.config?.url || !state.config?.key || !window.supabase) {
    state.supabase = null;
    return;
  }

  state.supabase = window.supabase.createClient(state.config.url, state.config.key);
}

function openSettings() {
  document.querySelector("#supabase-url").value = state.config?.url || "";
  document.querySelector("#supabase-key").value = state.config?.key || "";
  settingsDialog.showModal();
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
        <button class="secondary-button" type="button" data-action="open-settings-inline">Configurer Supabase</button>
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
  localStorage.setItem(ADMIN_ACCESS_KEY, "true");
  showToast("Acces admin valide.");
  location.hash = "#/host";
}

async function renderHost() {
  if (!state.adminAccess) return renderAdminGate();

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
          <span class="muted">${new Date(quiz.created_at).toLocaleDateString("fr-FR")}</span>
        </header>
        <p class="muted">${escapeHtml(quiz.description || "Sans description")}</p>
        <div class="row-actions">
          <a class="primary-button" href="#/host/${quiz.id}">Modifier</a>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">Aucun quiz pour l'instant.</div>`;
}

async function renderHostQuiz(quizId) {
  if (!state.adminAccess) return renderAdminGate();
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
          <label class="field">
            <span>Question</span>
            <textarea name="question" required maxlength="280" placeholder="Quelle est la capitale de... ?"></textarea>
          </label>
          ${[0, 1, 2, 3].map((index) => `
            <label class="field">
              <span>Reponse ${index + 1}</span>
              <input name="answer_${index}" required maxlength="120" placeholder="${ANSWER_COLORS[index]}" />
            </label>
          `).join("")}
          <label class="field">
            <span>Bonne reponse</span>
            <select name="correct_index">
              <option value="0">Reponse 1</option>
              <option value="1">Reponse 2</option>
              <option value="2">Reponse 3</option>
              <option value="3">Reponse 4</option>
            </select>
          </label>
          <label class="field">
            <span>Temps de reponse</span>
            <input name="duration" type="number" min="8" max="90" value="20" required />
          </label>
          <button class="primary-button" type="submit" ${disabledIfOffline()}>Ajouter</button>
        </form>
        <div class="panel">
          <div class="status-strip">
            <strong id="quiz-name">Quiz</strong>
            <button class="primary-button" type="button" data-action="start-session" ${disabledIfOffline()}>Lancer</button>
          </div>
          <div class="question-editor" id="question-list"></div>
        </div>
      </div>
    </section>
  `;

  document.querySelector("#question-form").addEventListener("submit", (event) => createQuestion(event, quizId));
  document.querySelector("[data-action='start-session']").addEventListener("click", () => startSession(quizId));
  await Promise.all([loadQuizTitle(quizId), loadQuestions(quizId)]);
}

async function loadQuizTitle(quizId) {
  if (!state.supabase) return;
  const { data } = await state.supabase.from("quizzes").select("title").eq("id", quizId).single();
  if (data) document.querySelector("#quiz-name").textContent = data.title;
}

async function createQuestion(event, quizId) {
  event.preventDefault();
  if (!requireSupabase()) return;

  const form = new FormData(event.currentTarget);
  const { count } = await state.supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", quizId);

  const payload = {
    quiz_id: quizId,
    body: String(form.get("question")).trim(),
    answers: [0, 1, 2, 3].map((index) => String(form.get(`answer_${index}`)).trim()),
    correct_index: Number(form.get("correct_index")),
    duration_seconds: Number(form.get("duration")),
    position: count || 0,
  };

  const { error } = await state.supabase.from("questions").insert(payload);
  if (error) return showToast(error.message);

  event.currentTarget.reset();
  showToast("Question ajoutee.");
  await loadQuestions(quizId);
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

  list.innerHTML = data.length
    ? data.map((question, index) => `
      <article class="question-card">
        <header>
          <strong>${index + 1}. ${escapeHtml(question.body)}</strong>
          <span class="pin">${question.duration_seconds}s</span>
        </header>
        <p class="muted">${question.answers.map((answer, answerIndex) => answerIndex === question.correct_index ? `✓ ${answer}` : answer).map(escapeHtml).join(" / ")}</p>
      </article>
    `).join("")
    : `<div class="empty-state">Ajoute au moins une question avant de lancer la partie.</div>`;
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
    current_question_index: -1,
  };

  const { data, error } = await state.supabase.from("game_sessions").insert(payload).select("id,code").single();
  if (error) return showToast(error.message);

  showToast(`Session ${data.code} lancee.`);
  location.hash = `#/session/${data.id}`;
}

async function renderLiveSession(sessionId) {
  if (!state.adminAccess) return renderAdminGate();
  if (!sessionId) return renderHost();

  app.innerHTML = `
    <section class="page">
      <div class="page-title">
        <div>
          <p class="eyebrow">Live admin</p>
          <h1 id="session-title">Session</h1>
          <p>Le code s'affiche aux joueurs, puis chaque question avance au rythme de l'admin.</p>
        </div>
        <a class="secondary-button" href="#/host">Quitter</a>
      </div>
      ${connectionNotice()}
      <div class="split">
        <div class="panel">
          <p class="eyebrow">Code partie</p>
          <div class="game-code" id="game-code">----</div>
          <div class="row-actions">
            <button class="primary-button" type="button" data-action="next-question" ${disabledIfOffline()}>Question suivante</button>
            <button class="danger-button" type="button" data-action="end-session" ${disabledIfOffline()}>Terminer</button>
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

  document.querySelector("[data-action='next-question']").addEventListener("click", () => advanceQuestion(sessionId));
  document.querySelector("[data-action='end-session']").addEventListener("click", () => endSession(sessionId));
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
  document.querySelector("#session-status").textContent = session.status;

  await renderPlayers(sessionId);
  renderLiveQuestion(current, session);
}

async function renderPlayers(sessionId) {
  const list = document.querySelector("#player-list");
  const { data, error } = await state.supabase
    .from("game_players")
    .select("nickname,score,joined_at")
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
        <span class="pin">${player.score} pts</span>
      </div>
    `).join("")
    : `<div class="empty-state">En attente des joueurs.</div>`;
}

function renderLiveQuestion(question, session) {
  const node = document.querySelector("#live-question");
  if (session.status === "finished") {
    node.innerHTML = `<div class="empty-state">Partie terminee.</div>`;
    return;
  }

  if (!question) {
    node.innerHTML = `<div class="empty-state">La partie est dans le lobby. Lance la premiere question.</div>`;
    return;
  }

  node.innerHTML = `
    <p class="eyebrow">Question ${session.current_question_index + 1}</p>
    <h2>${escapeHtml(question.body)}</h2>
    <div class="answer-grid">
      ${question.answers.map((answer) => `<div class="answer-tile">${escapeHtml(answer)}</div>`).join("")}
    </div>
  `;
}

async function advanceQuestion(sessionId) {
  if (!requireSupabase()) return;

  const { data: session, error } = await state.supabase
    .from("game_sessions")
    .select("id,quiz_id,current_question_index,status")
    .eq("id", sessionId)
    .single();
  if (error) return showToast(error.message);

  const { count } = await state.supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", session.quiz_id);

  const nextIndex = session.current_question_index + 1;
  if (nextIndex >= count) return endSession(sessionId);

  const { error: updateError } = await state.supabase
    .from("game_sessions")
    .update({ current_question_index: nextIndex, status: "playing", question_started_at: new Date().toISOString() })
    .eq("id", sessionId);

  if (updateError) return showToast(updateError.message);
}

async function endSession(sessionId) {
  if (!requireSupabase()) return;
  const { error } = await state.supabase.from("game_sessions").update({ status: "finished" }).eq("id", sessionId);
  if (error) return showToast(error.message);
  showToast("Partie terminee.");
}

async function joinGame(event) {
  event.preventDefault();
  if (!requireSupabase()) return;

  const form = new FormData(event.currentTarget);
  const code = String(form.get("code")).trim().toUpperCase();
  const nickname = String(form.get("nickname")).trim();

  const { data: session, error: sessionError } = await state.supabase
    .from("game_sessions")
    .select("id,status")
    .eq("code", code)
    .neq("status", "finished")
    .single();

  if (sessionError || !session) return showToast("Partie introuvable.");

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
    await renderFinalScores(sessionId, view);
    return;
  }

  if (!question) {
    view.innerHTML = `<div class="empty-state">En attente de la prochaine question.</div>`;
    return;
  }

  const { data: existing } = await state.supabase
    .from("game_answers")
    .select("id,answer_index")
    .eq("session_id", sessionId)
    .eq("player_id", state.player.id)
    .eq("question_id", question.id)
    .maybeSingle();

  view.innerHTML = `
    <p class="eyebrow">Question ${session.current_question_index + 1}</p>
    <h2>${escapeHtml(question.body)}</h2>
    <div class="choice-grid">
      ${question.answers.map((answer, index) => `
        <button class="answer-button ${existing?.answer_index === index ? "is-selected" : ""}" type="button" data-answer="${index}" ${existing ? "disabled" : ""}>
          ${escapeHtml(answer)}
        </button>
      `).join("")}
    </div>
  `;

  view.querySelectorAll("[data-answer]").forEach((button) => {
    button.addEventListener("click", () => submitAnswer(sessionId, question, Number(button.dataset.answer)));
  });
}

async function submitAnswer(sessionId, question, answerIndex) {
  if (!requireSupabase()) return;

  const isCorrect = answerIndex === question.correct_index;
  const points = isCorrect ? 100 : 0;
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

  showToast(isCorrect ? "Bonne reponse, +100 !" : "Reponse envoyee.");
  await refreshPlayerView(sessionId);
}

async function renderFinalScores(sessionId, view) {
  const { data, error } = await state.supabase
    .from("game_players")
    .select("nickname,score")
    .eq("session_id", sessionId)
    .order("score", { ascending: false });

  if (error) {
    view.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  view.innerHTML = `
    <p class="eyebrow">Resultats</p>
    <h2>Classement final</h2>
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

  const channel = state.supabase
    .channel(`session-${sessionId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "game_sessions", filter: `id=eq.${sessionId}` }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "game_players", filter: `session_id=eq.${sessionId}` }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "game_answers", filter: `session_id=eq.${sessionId}` }, callback)
    .subscribe();

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
      <button class="secondary-button" type="button" data-action="open-settings-inline">Configurer</button>
    </div>
  `;
}

function disabledIfOffline() {
  return state.supabase ? "" : "disabled";
}

function requireSupabase() {
  if (state.supabase) return true;
  showToast("Configure Supabase avant de continuer.");
  openSettings();
  return false;
}

document.addEventListener("click", (event) => {
  if (event.target.matches("[data-action='open-settings-inline']")) openSettings();
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function loadConfig() {
  return loadJson(CONFIG_KEY, null);
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
