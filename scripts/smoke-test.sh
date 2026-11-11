#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Nuance — test de fumée de l'API déployée
# Usage : ./scripts/smoke-test.sh https://votre-domaine.fr
# Vérifie que les 7 endpoints répondent et respectent le contrat.
# ---------------------------------------------------------------------
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "Usage : $0 https://votre-domaine.fr" >&2
  exit 1
fi
BASE="${BASE%/}"
JAR="$(mktemp)"
PAGE="$(mktemp)"
trap 'rm -f "$JAR" "$PAGE"' EXIT

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
ko()   { echo "  ✗ $1"; echo "      → $2"; fail=$((fail+1)); }

# $1 = libellé, $2 = code attendu, $3... = arguments curl
expect_code() {
  local label="$1" want="$2"; shift 2
  local out code
  out=$(curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null)
  code="$out"
  if [ "$code" = "$want" ]; then ok "$label (HTTP $code)"; else ko "$label" "attendu $want, reçu $code"; fi
}

echo "Cible : $BASE"
echo

echo "── 1. Disponibilité de l'API ──"
session_json=$(curl -sS "$BASE/api/auth/session" 2>/dev/null || echo '')
if echo "$session_json" | grep -q '"ok"'; then
  ok "GET /api/auth/session répond du JSON"
else
  ko "GET /api/auth/session" "pas de JSON — l'API n'est pas branchée sur /api/*"
fi
if echo "$session_json" | grep -q 'hasAnyAccount'; then
  ok "champ hasAnyAccount présent (contrat respecté)"
else
  ko "hasAnyAccount absent" "vérifiez que worker/index.js est bien déployé"
fi
if echo "$session_json" | grep -q '"authenticated":false'; then
  ok "non authentifié par défaut"
fi

echo
echo "── 2. Fichier statique ──"
ctype=$(curl -sS -o /dev/null -w '%{content_type}' "$BASE/" 2>/dev/null)
case "$ctype" in
  text/html*) ok "la page d'accueil est servie ($ctype)" ;;
  *) ko "page d'accueil" "content-type reçu : ${ctype:-aucun}" ;;
esac
# On écrit la page dans un fichier : la variable shell ne doit pas porter 3 Mo.
curl -sS "$BASE/" -o "$PAGE" 2>/dev/null || true
size=$(wc -c < "$PAGE" 2>/dev/null || echo 0)
if [ "$size" -gt 100000 ]; then ok "page complète reçue ($(du -h "$PAGE" | cut -f1))"; else ko "page trop petite" "$size octets"; fi
if grep -q 'Nuance' "$PAGE"; then ok "le titre Nuance est présent"; else ko "titre Nuance" "le mauvais index.html est peut-être déployé"; fi
if grep -q 'view-auth' "$PAGE"; then ok "la vue de connexion est présente"; else ko "vue-auth" "vous avez publié une version sans la couche comptes"; fi
if grep -q 'apiFetch' "$PAGE"; then ok "le client API est présent (apiFetch)"; else ko "apiFetch absent" "le fichier publié n'a pas la couche comptes"; fi

echo
echo "── 3. En-têtes de sécurité ──"
hdr=$(curl -sSI "$BASE/" 2>/dev/null || true)
for h in "X-Content-Type-Options" "X-Frame-Options" "Referrer-Policy" "Content-Security-Policy"; do
  if printf '%s' "$hdr" | grep -qi "^$h:"; then ok "$h présent"; else ko "$h absent" "vérifiez withSecurity() dans worker.js"; fi
done

echo
echo "── 4. Comportement des routes protégées ──"
expect_code "PUT /api/state sans session → 401" 401 -X PUT -H 'Content-Type: application/json' -d '{"state":{}}' "$BASE/api/state"
expect_code "GET /api/state/backups sans session → 401" 401 "$BASE/api/state/backups"
expect_code "GET /api/state/backup?id=1 sans session → 401" 401 "$BASE/api/state/backup?id=1"
expect_code "route inconnue → 404" 404 "$BASE/api/inexistant"
expect_code "register avec e-mail invalide → 400" 400 -X POST -H 'Content-Type: application/json' -d '{"email":"pasunemail","password":"motdepasse123"}' "$BASE/api/auth/register"
expect_code "register avec mot de passe court → 400" 400 -X POST -H 'Content-Type: application/json' -d '{"email":"valide@exemple.fr","password":"court"}' "$BASE/api/auth/register"

echo
echo "── 5. Cookie de session ──"
cookie_hdr=$(curl -sS -D - -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"email":"","password":""}' "$BASE/api/auth/login" 2>/dev/null | grep -i '^set-cookie' || true)
if [ -n "$cookie_hdr" ]; then
  if printf '%s' "$cookie_hdr" | grep -qi 'HttpOnly'; then ok "cookie HttpOnly"; else ko "cookie sans HttpOnly" "risque XSS"; fi
  if printf '%s' "$cookie_hdr" | grep -qi 'Secure'; then ok "cookie Secure"; else ko "cookie sans Secure" "vérifiez cookieHeader()"; fi
  if printf '%s' "$cookie_hdr" | grep -qi 'SameSite=Lax'; then ok "cookie SameSite=Lax"; fi
else
  echo "  · pas de Set-Cookie sur un login invalide (attendu si les identifiants sont vides)"
fi

echo
echo "════════════════════════════════════════════"
echo "  $pass réussi(s), $fail échec(s)"
echo "════════════════════════════════════════════"
echo
echo "Pour un test d'inscription réelle, utilisez un e-mail jetable :"
echo "  curl -i -X POST $BASE/api/auth/register \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"email\":\"test@example.com\",\"password\":\"motdepasse123\"}'"
echo
[ "$fail" -eq 0 ]
