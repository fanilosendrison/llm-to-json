---
id: SPEC-LLM-TO-JSON-V14
version: "0.1.0"
scope: Spec normative complète du package llm-to-json (architecture, flux extract(), interpolation, erreurs, logging, Ajv config)
status: draft
validates: [src/*.ts, tests/*.ts]
---

# llm-to-json

> **Repo** : `github:fanilosendrison/llm-to-json`
> **Classe principale** : `StructuredExtractor` — toutes les références à `StructuredExtractor` dans les specs (Phase E, Brief Système, contrats C1–C6) désignent la classe exportée par ce package.

Package standalone qui transforme du texte libre produit par un agent LLM en JSON typé. Le LLM intervient uniquement comme **parser sémantique** — il ne décide de rien, il extrait. Le LLM doit retourner **uniquement** un objet JSON, sans aucun texte additionnel, sans backticks, sans explication. Si la réponse n'est pas du JSON pur, c'est une erreur fatale.

**Cycle invariant** : réponse agent (texte libre) → LLM extraction → JSON.parse → validation schema → parse typé → retour à l'appelant.

Un seul essai. Si ça échoue, c'est fatal — l'appelant logge tout (prompt, réponse brute, erreur) et s'arrête. Pas de retry : avec temperature 0 et un prompt d'extraction clair, si ça casse c'est un bug en amont (prompt agent défaillant), pas un problème de chance.

> **Règle normative — no retry interne** : le `StructuredExtractor` n'implémente aucun mécanisme de retry. Un appel à `extract()` = un appel LLM. Si le LLM échoue, `ExtractionFatalError` est throw immédiatement. Les consommateurs ne devraient pas non plus wrapper `extract()` dans une boucle retry — si l'extraction échoue à temperature 0, le problème est structurel (prompt agent défaillant), pas stochastique.

> **Règle normative — no markdown strip** : le package ne tente jamais de nettoyer la réponse LLM (pas de strip de backticks markdown, pas de trim de texte avant/après le JSON). La réponse brute est passée telle quelle à `JSON.parse()`. Si le LLM wrappe sa réponse en ` ```json ... ``` `, c'est une `ExtractionFatalError('INVALID_JSON')`. Le prompt d'extraction est la seule ligne de défense — c'est au consommateur de l'écrire clairement.

> **Nuance** : "fatal" signifie que l'**extraction elle-même** a échoué (JSON invalide, schema violation, erreur de parse). Certains contrats acceptent un **résultat valide d'abstention** (ex: `decided: false`) — ce n'est pas un échec d'extraction, c'est un signal exploitable par l'appelant.

---

## Architecture

### ExtractionContract

Chaque point d'extraction est défini par un **contrat déclaratif**. Les contrats sont définis par les consommateurs du package — le `StructuredExtractor` ne connaît pas ses appelants.

| Champ                | Rôle                                                        |
| -------------------- | ----------------------------------------------------------- |
| `id`                 | Identifiant unique du contrat — utilisé dans les erreurs et le logging |
| `sourceAgent`        | Quel agent vient de répondre — utilisé dans le logging      |
| `contextDescription` | Contexte injecté dans le **system** prompt (template avec `{{variables}}`) |
| `extractionPrompt`   | Prompt template pour le **user** prompt du LLM extracteur   |
| `outputSchema`       | JSON Schema pour validation structurelle — statique ou dynamique (voir ci-dessous) |
| `maxTokens`          | *(optionnel)* Limite de tokens pour la réponse LLM. Défaut : `1024`. Doit être un entier > 0. |
| `parse(raw)`         | Cast typé vers `T` + vérification des invariants métier non exprimables en JSON Schema (si aucun invariant : le cast typé seul est suffisant) |

> **Usage de `id` et `sourceAgent`** : ces champs sont utilisés par le `StructuredExtractor` dans deux contextes : (1) enrichissement des erreurs — `TemplateInterpolationError` reçoit `contractId`, et `ExtractionFatalError` inclut `contractId` pour le debug ; (2) logging structuré — un log d'entrée est émis **au tout début** du corps de `extract()` (avant toute validation — étape 0) avec `{ event: 'extract_start', contractId: contract.id, sourceAgent: contract.sourceAgent, timestamp }`, et un log de sortie est émis **après le retour ou l'erreur** (étape 10 ou catch) avec `{ event: 'extract_end', contractId, sourceAgent, success: boolean, errorType?, timestamp }`. Le format de logging est un `console.error` JSON one-line. Les consommateurs ne doivent pas compter sur ce logging pour leur propre observabilité — c'est du logging interne au package pour le debug.
>
> **Format du logging** : `timestamp` est un ISO 8601 string (`new Date().toISOString()`). `errorType` est : `error.type` pour `ExtractionFatalError`, `error.name` pour toute autre erreur (`'TemplateInterpolationError'`, `'TypeError'`, etc.). Si l'erreur n'a pas de `name`, utiliser `'unknown'`. Le log est émis via `console.error(JSON.stringify({ ... }))` — une string JSON sérialisée, pas un objet passé directement à `console.error`. L'ordre des clés dans le JSON n'est pas normatif — les tests doivent parser le JSON et vérifier les valeurs, pas comparer des strings.
>
> **Implémentation du logging** : `extract()` commence par le log `extract_start` (étape 0), puis le reste du corps (étapes 1–10) est wrappé dans un `try/catch` **uniquement pour le logging**. Le catch logge `extract_end` avec `success: false` puis fait un **re-throw immédiat** sans transformation. Le happy path logge `extract_end` avec `success: true` après l'étape 10. Ce n'est pas en contradiction avec la règle "ne catch jamais les erreurs non-extraction" — cette règle signifie que les erreurs ne sont jamais **wrappées** ni **absorbées**. Le catch de logging est transparent : il observe, logge, et re-throw. L'erreur arrive à l'appelant **identique** à ce qu'elle serait sans le logging. Le pairing `extract_start`/`extract_end` est garanti : `extract_start` est émis inconditionnellement avant le try, `extract_end` est émis dans le try (success) ou le catch (failure).

#### Mapping prompt

Le mapping entre les champs du contrat et les arguments de `LLMClient.complete()` est **fixe et normatif** :

- `contextDescription` (interpolé) → paramètre `system`
- `extractionPrompt` (interpolé) → paramètre `user`

Aucune logique supplémentaire de composition. Un champ = un paramètre.

> **Champs vides autorisés** : `contextDescription` et `extractionPrompt` peuvent être des strings vides. Un `contextDescription` vide produit un system prompt vide, ce qui est valide pour la plupart des providers LLM. L'interpolation d'un template vide retourne une string vide sans erreur (aucun placeholder à résoudre). Il n'y a pas de validation de longueur minimale sur ces champs — la qualité du contrat est la responsabilité du consommateur.

#### Répartition des responsabilités : schema vs parse()

Le JSON Schema et la fonction `parse()` ont des rôles **distincts et complémentaires** :

| Responsabilité | JSON Schema (étape 8) | `parse()` (étape 9) |
|---|---|---|
| Structure | ✅ Types des champs, champs requis, enum de valeurs fixes | ❌ Ne re-vérifie pas la structure |
| Bornes simples | ✅ `minimum`, `maximum`, `minLength`, `pattern` quand exprimable | ❌ |
| Invariants croisés | ⚠️ Certains sont expressibles via `if/then/else` (draft-07) — les mettre dans le schema quand c'est le cas. Ex: `decided ↔ decision` (C6), `resolution_type ↔ fix/choices` (C3), `coherent_with_parents ↔ new_incoherences` (C2) | ✅ Complète pour les invariants non exprimables. Ex: `incoherences_count === incoherences.length` (C1 — cross-reference integer/array length impossible en JSON Schema), cross-validation contextuelle `incoherence_id` (C3/C4 — comparaison avec variable externe) |
| Invariants contextuels | ❌ Pas d'accès au contexte d'appel | ✅ Via closure sur les variables (voir "Pattern factory") |
| Typage retour | ❌ Retourne `unknown` | ✅ Retourne `T` typé |

**Règle normative** : tout ce qui est exprimable en JSON Schema **doit** être dans le schema. `parse()` ne duplique pas les vérifications du schema — elle les complète avec les invariants que le schema ne peut pas exprimer. Si un implémenteur met un schema trivial (`{ "type": "object" }`) et fait tout dans `parse()`, c'est une violation de la spec.

**Règle normative — schemas multi-variants** : quand une `reason` admet plusieurs formes de `decision` (ex: `MALFORMED_FENCE` → `FIX_CLOSER` ou `REMOVE_FENCE`), le JSON Schema **doit** utiliser `oneOf` avec un discriminant sur le champ d'action. Exemple pour `MALFORMED_FENCE` :

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "action": { "const": "FIX_CLOSER" },
        "fence_char": { "enum": ["`", "~"] },
        "fence_len": { "type": "integer", "minimum": 1 }
      },
      "required": ["action", "fence_char", "fence_len"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": { "const": "REMOVE_FENCE" }
      },
      "required": ["action"],
      "additionalProperties": false
    }
  ]
}
```

Les reasons concernées sont : `MALFORMED_FENCE`, `SUSPICIOUS_FENCE_CONTENT`, `NUMBERING_PARENT_MISMATCH`, `POSSIBLE_HEADING_NO_MARKUP`, `MULTILINE_NOT_A_TITLE`.

**Exemple concret** (C6, reason `UNCLOSED_FENCE`) :
- **Schema** valide : `decided` est boolean ; via `if/then/else` : si `decided === true` alors `decision` est un objet avec `close_after_line` (integer, minimum 1), `fence_char` (enum `["\`", "~"]`), `fence_len` (integer, minimum 1) ; si `decided === false` alors `decision` est `null`
- **`parse()`** valide : injecte `reason` dans l'objet retourné via closure (seul invariant non exprimable en schema)
- **L'appelant** (Normalizer) valide après réception : `close_after_line` est dans les bornes du document, car `parse()` n'a pas accès au document

#### Schema statique vs dynamique

`outputSchema` accepte deux formes :

```typescript
outputSchema: JSONSchema | ((variables: Record<string, string>) => JSONSchema);
```

- **Statique** (`JSONSchema`) : utilisé par C1–C5 où le schema ne change pas d'un appel à l'autre.
- **Dynamique** (`(variables) => JSONSchema`) : utilisé par C6 où le schema varie selon `variables.reason`. La fonction est appelée par `extract()` avec le dictionnaire de variables **post-injection** (après injection de `agent_response`) pour résoudre le schema avant validation. La fonction retourne le schema **complet** — le package ne connaît pas la sémantique du contrat et n'ajoute aucun wrapper. Pour C6, la fonction retourne un schema qui valide `{ decided: boolean, decision: ... | null }` en entier, pas juste le schema de `decision`.

#### Interface TypeScript complète

Le type `JSONSchema` est un alias pour le type schema d'Ajv :

```typescript
import type { SchemaObject } from 'ajv';
type JSONSchema = SchemaObject;
```

> Ce type est **re-exporté** par le package pour que les consommateurs puissent typer leurs schemas sans dépendre directement d'Ajv.

```typescript
interface ExtractionContract<T> {
  id: string;
  sourceAgent: string;
  contextDescription: string;
  extractionPrompt: string;
  outputSchema: JSONSchema | ((variables: Record<string, string>) => JSONSchema);
  maxTokens?: number; // défaut: 1024, doit être entier > 0
  parse(raw: unknown): T;
}
```

#### Pattern factory pour `parse()` et variables contextuelles

La signature de `parse()` est `parse(raw: unknown): T` — elle ne reçoit pas les variables contextuelles en argument. Quand `parse()` a besoin d'accéder aux variables (pour cross-validation, injection de discriminants, etc.), le contrat est construit par une **factory** qui capture les variables en closure.

**Quand utiliser une factory** :
- **Contrat singleton** (C1, C2, C5) : `parse()` n'a besoin d'aucune variable contextuelle. Le contrat est un objet statique.
- **Contrat factory** (C3, C4, C6) : `parse()` a besoin de variables (cross-validation `incoherence_id`, injection du discriminant `reason`). Le contrat est produit par une fonction qui capture les variables.

> **⚠️ Les exemples ci-dessous illustrent le pattern factory tel qu'il est utilisé côté consommateur.** Les types (`AuditInternalResult`, `PatchPlannerResult`, `StructureAnalyzerResult`), les factories (`makePatchPlannerContract`, `makeStructureAnalyzerContract`), et la fonction `buildSchemaForReason` ne font **pas** partie du package — ils ne doivent pas être implémentés ici. Le package exporte uniquement l'interface `ExtractionContract<T>` et le mécanisme `StructuredExtractor`.

```typescript
// Contrat singleton — C1 (parse n'a besoin de rien d'externe)
const AuditInternalContract: ExtractionContract<AuditInternalResult> = {
  id: 'C1',
  sourceAgent: 'Auditor',
  contextDescription: '...',
  extractionPrompt: '...',
  outputSchema: { ... },
  parse(raw) {
    const data = raw as { incoherences_count: number; incoherences: unknown[] };
    if (data.incoherences_count !== data.incoherences.length) throw new Error('count mismatch');
    return data as AuditInternalResult;
  }
};

// Contrat factory — C3 (parse cross-valide incoherence_id)
function makePatchPlannerContract(variables: { incoherence_id: string }): ExtractionContract<PatchPlannerResult> {
  return {
    id: 'C3',
    sourceAgent: 'PatchPlanner',
    contextDescription: '...',
    extractionPrompt: '...',
    outputSchema: { ... },
    parse(raw) {
      const data = raw as PatchPlannerResult;
      if (data.incoherence_id !== variables.incoherence_id) {
        throw new Error(`incoherence_id mismatch: got ${data.incoherence_id}, expected ${variables.incoherence_id}`);
      }
      // resolution_type ↔ fix/choices coherence is enforced by the JSON Schema
      // parse() only cross-validates incoherence_id via closure
      return data;
    }
  };
}

// Contrat factory — C6 (parse injecte reason)
function makeStructureAnalyzerContract(variables: { reason: string }): ExtractionContract<StructureAnalyzerResult> {
  return {
    id: 'C6',
    sourceAgent: 'StructureAnalyzer',
    contextDescription: '...',
    extractionPrompt: '...',
    outputSchema: buildSchemaForReason, // fonction dynamique
    parse(raw) {
      const data = raw as { decided: boolean; decision: unknown };
      // decided ↔ decision coherence is enforced by the JSON Schema (if/then/else)
      // parse() only injects the reason discriminant
      if (data.decided) {
        return { decided: true, decision: { ...data.decision as object, reason: variables.reason } } as StructureAnalyzerResult;
      }
      return { decided: false, decision: null } as StructureAnalyzerResult;
    }
  };
}
```

> **Règle normative — cohérence factory/variables pour C6** : la `reason` passée à `makeStructureAnalyzerContract({ reason })` **doit** être identique à celle passée dans le dictionnaire de variables de `extract()`. La factory capture `reason` en closure pour l'injection dans `parse()` ; le dictionnaire de variables utilise `reason` pour l'interpolation des templates et la résolution du schema dynamique. Si les deux divergent, `parse()` injectera un discriminant incohérent avec le schema validé — un bug silencieux que ni le package ni le JSON Schema ne peuvent détecter. C'est la responsabilité de l'appelant.

**Usage côté appelant avec factory** :

```typescript
// L'appelant construit le contrat AVANT d'appeler extract()
const contract = makePatchPlannerContract({ incoherence_id: currentId });
const result = await extractor.extract(agentResponse, contract, { incoherence_id: currentId });
```

> **Règle normative** : le `StructuredExtractor` ne sait pas si le contrat est un singleton ou produit par une factory — il appelle `contract.parse(parsed)` dans les deux cas. La factory est un pattern côté consommateur, pas une mécanique du package. Les champs `id` et `sourceAgent` d'un contrat factory **doivent** être identiques entre toutes les instances produites par la même factory (ex: toujours `'C3'` et `'PatchPlanner'`). Ils identifient le **type** de contrat, pas l'appel individuel — le logging structuré du package ajoute déjà un timestamp pour distinguer les appels.

#### Ownership des schemas et contrats

Les JSON Schemas sont définis **par les consommateurs**, pas par ce package. Le `StructuredExtractor` reçoit un schema dans le contrat et le valide — il ne connaît pas la sémantique des contrats C1–C6. Les schemas sont documentés dans `llm-to-json-contracts-ref.md` comme **spécifications normatives** que les consommateurs doivent implémenter dans leur propre repo. Le package fournit le mécanisme de validation, pas les schemas eux-mêmes.

### StructuredExtractor

Composant sans état applicatif — il ne retient rien entre les appels à `extract()`. Reçoit à l'instanciation un `LLMClient` injecté par le consommateur et crée une instance Ajv de configuration (immutable). Le package ne gère ni config, ni clés API, ni choix de provider.

```typescript
interface LLMClient {
  complete(system: string, user: string, config: { temperature: number; maxTokens: number }): Promise<string>;
}

const extractor = new StructuredExtractor(llmClient);
```

#### Méthode `extract()`

```typescript
async extract<T>(
  agentResponse: string,
  contract: ExtractionContract<T>,
  variables: Record<string, string>
): Promise<T>
```

Par appel, reçoit :
- La réponse brute de l'agent (`agentResponse` — string)
- Un contrat d'extraction
- Un dictionnaire de variables contextuelles

Retourne : l'objet typé `T` ou throw fatal.

#### Flux interne de `extract()`

```
0. Logging d'entrée : console.error(JSON.stringify({ event: 'extract_start', contractId: contract.id, sourceAgent: contract.sourceAgent, timestamp: new Date().toISOString() }))
   Puis le corps est wrappé dans un try/catch/finally pour le logging de sortie.
1. Validation d'entrée : si agentResponse est vide ou whitespace-only (`agentResponse.trim() === ''`) → throw TypeError('agentResponse must be a non-empty string')
2. Clone défensif : variables = { ...variables }
   Injection automatique : variables["agent_response"] = agentResponse
   (le dictionnaire original de l'appelant n'est jamais muté)
3. Validation maxTokens : si contract.maxTokens est défini et (non entier ou <= 0) → throw TypeError('maxTokens must be a positive integer')
4. Interpolation : system = interpolate(contract.contextDescription, variables, contract.id, 'contextDescription')
                   user   = interpolate(contract.extractionPrompt, variables, contract.id, 'extractionPrompt')
5. Résolution schema : si `typeof contract.outputSchema === 'function'` → `isDynamic = true`, `resolvedSchema = contract.outputSchema(variables)`
                        si `typeof contract.outputSchema === 'object'` → `isDynamic = false`, `resolvedSchema = contract.outputSchema`
6. Appel LLM : llmClient.complete(system, user, { temperature: 0, maxTokens: contract.maxTokens ?? 1024 })
7. JSON.parse(rawResponse) — si échec → ExtractionFatalError('INVALID_JSON', rawResponse, contract.id, extractMessage(error))
8. Validation schema (Ajv) — si échec → ExtractionFatalError('SCHEMA_VIOLATION', rawResponse, contract.id, ajv.errorsText())
   Nettoyage : si `isDynamic === true` (flag stocké à l'étape 5), `ajv.removeSchema(resolvedSchema)` **dans un `finally`** qui wrappe **les étapes 8–9 uniquement** (post-compile). La référence passée à `removeSchema` **doit** être la même que celle passée à `compile()` — c'est la variable `resolvedSchema` stockée à l'étape 5. Ne **jamais** rappeler `contract.outputSchema(variables)` pour obtenir une nouvelle référence. Ne **jamais** appeler removeSchema sur un schema statique — cela casserait le pré-compile optionnel. Le scope du `finally` commence **après** `ajv.compile(resolvedSchema)` pour éviter d'appeler `removeSchema` sur un schema jamais compilé (ex: si JSON.parse échoue à l'étape 7).
9. contract.parse(parsed) — si throw → ExtractionFatalError('PARSE_ERROR', rawResponse, contract.id, extractMessage(error))
10. Retour T
```

> **Extraction du message d'erreur** : `parse()` est définie par le consommateur et peut throw n'importe quoi (`Error`, string, number...). L'implémentation doit extraire le message de manière robuste : `error instanceof Error ? error.message : String(error)`. Ce helper interne (`extractMessage`) n'est pas exporté.

> **Ce que `parse()` reçoit** : l'argument `raw` de `parse()` est le retour direct de `JSON.parse()` (étape 7). Le schema validator (étape 8) ne transforme ni ne coerce la valeur — il valide seulement. `parse()` reçoit donc exactement ce que `JSON.parse()` a produit, à condition que la validation schema ait réussi. Le type `unknown` reflète le fait que le package ne connaît pas `T` — c'est le contrat qui sait.

#### Injection automatique de `agent_response`

Le package clone le dictionnaire de variables puis injecte la clé `agent_response` dans le **clone** avant interpolation. L'appelant ne doit **pas** la fournir — s'il le fait, la valeur est écrasée silencieusement par le premier argument de `extract()` dans le clone. Le dictionnaire original de l'appelant n'est **jamais muté**. C'est normatif : `agent_response` dans un template fait toujours référence à la réponse brute passée en premier argument.

#### Configuration fixe côté package

- `temperature: 0` : extraction = déterministe au maximum (passé au `LLMClient` à chaque appel)

### Interpolation de templates

Les templates (`contextDescription`, `extractionPrompt`) utilisent la syntaxe `{{variable_name}}`. L'interpolation est un **simple remplacement de chaîne** — pas de logique, pas de conditionnels, pas de boucles.

```typescript
function interpolate(
  template: string,
  variables: Record<string, string>,
  contractId: string,
  templateField: 'contextDescription' | 'extractionPrompt'
): string
```

> **Règle normative — implémentation du remplacement** : l'interpolation **doit** utiliser une **function replacement** et non un string replacement direct. `String.prototype.replace(regex, string)` interprète les séquences spéciales `$1`, `$&`, `$$`, `` $` ``, `$'` dans la valeur de remplacement — or `agent_response` contient du texte libre LLM qui peut inclure ces caractères (code, prix en dollars, regex). L'implémentation correcte est :
>
> ```typescript
> return template.replace(PLACEHOLDER_REGEX, (_, name) => {
>   if (!(name in variables)) throw new TemplateInterpolationError(name, contractId, templateField);
>   return variables[name];
> });
> ```
>
> Cette forme traite la valeur comme littérale — aucune interprétation des `$`.

#### Pattern des placeholders

Le pattern de détection des placeholders est normativement défini comme :

```typescript
const PLACEHOLDER_REGEX = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
```

- Un placeholder commence par `{{` et finit par `}}`
- Le nom de variable suit les règles d'identifiant : commence par une lettre ou `_`, suivi de lettres, chiffres ou `_`
- **Pas d'espaces** à l'intérieur des accolades : `{{ x }}` n'est pas un placeholder (il est laissé tel quel dans le template sans erreur)
- Les noms valides incluent : `agent_response`, `reason`, `start_line`, `reason_schema_instructions`

**Comportement sur variable manquante** : voir l'implémentation de référence ci-dessus — si un placeholder `{{x}}` (matchant la regex) n'a pas de correspondance dans le dictionnaire, l'interpolation throw une `TemplateInterpolationError` depuis le callback de remplacement.

**Comportement sur variables excédentaires** : si le dictionnaire de variables contient des clés qui ne correspondent à aucun placeholder dans le template, ces clés sont **ignorées silencieusement**. Ce n'est pas une erreur — c'est le cas normal quand le même dictionnaire de variables est passé à `contextDescription` et `extractionPrompt` qui n'utilisent pas forcément les mêmes variables.

```typescript
class TemplateInterpolationError extends Error {
  variableName: string;   // la variable manquante
  contractId: string;     // le contrat concerné
  templateField: 'contextDescription' | 'extractionPrompt';  // le template concerné

  constructor(variableName: string, contractId: string, templateField: 'contextDescription' | 'extractionPrompt') {
    super(`Missing variable '${variableName}' in ${templateField} of contract ${contractId}`);
    this.name = 'TemplateInterpolationError';
    this.variableName = variableName;
    this.contractId = contractId;
    this.templateField = templateField;
  }
}
```

### Validation schema

La validation JSON Schema utilise **Ajv** (ou compatible) avec la configuration suivante :

| Option | Valeur | Raison |
|---|---|---|
| Draft | JSON Schema draft-07 (`ajv` par défaut) | Suffisant pour tous les contrats C1–C6, pas besoin de 2019-09/2020-12 |
| `allErrors` | `false` | Fail-fast — on veut la première erreur, pas un rapport complet |
| `coerceTypes` | `false` | Pas de coercion — le LLM doit produire les bons types |
| `additionalProperties` | Non forcé globalement — **chaque schema doit le spécifier explicitement** | Certains contrats peuvent vouloir être stricts, d'autres permissifs. C'est la responsabilité du schema, pas du validator. |
| `useDefaults` | `false` | Pas de mutation de l'objet validé — `parse()` reçoit exactement `JSON.parse(raw)` |
| `strict` | `true` | Détecte les erreurs de schema à la compilation (champs inconnus, etc.) |

> **Règle normative** : le validator ne doit jamais **transformer** l'objet validé. Il valide et retourne un booléen. `parse()` reçoit toujours le retour brut de `JSON.parse()`.

L'instance Ajv est créée **une fois** dans le constructeur de `StructuredExtractor` et réutilisée. Les schemas statiques peuvent être pré-compilés si l'implémenteur le souhaite (optimisation, pas normatif).

> **Schemas dynamiques et mémoire** : les schemas dynamiques sont validés via `ajv.compile(schema)` à chaque appel, ce qui ajoute le schema au cache interne d'Ajv. Pour éviter une fuite mémoire sur de longues sessions (ex: pipeline Normalizer avec 50+ spans), l'implémentation **doit** appeler `ajv.removeSchema(resolvedSchema)` après chaque validation dynamique, dans un `finally` qui wrappe les étapes 8–9 (post-compile), en passant **la même référence objet** que celle retournée par `contract.outputSchema(variables)` à l'étape 5. Les schemas dynamiques ne doivent **pas** avoir de `$id` — le cleanup se fait par référence objet, pas par identifiant. Les schemas statiques ne posent pas ce problème — leur référence est stable et le cache est borné.

> **Erreurs de compilation schema** : si un consommateur fournit un schema malformé, Ajv avec `strict: true` throw à la compilation (avant la validation). Cette erreur est dans la même catégorie que les erreurs non-extraction (outputSchema throw, TypeError) — elle propage directement à l'appelant sans wrapping. C'est un bug du code appelant (schema défectueux), pas un échec d'extraction.

### ExtractionFatalError

Erreur non-rattrapable avec :
- `type` : `INVALID_JSON | SCHEMA_VIOLATION | PARSE_ERROR`
- `rawOutput` : la réponse brute du LLM pour debug
- `contractId` : l'id du contrat pour traçabilité
- `details` : information supplémentaire de debug — message `JSON.parse` pour `INVALID_JSON` (ex: `"Unexpected token < in JSON at position 0"`), message Ajv pour `SCHEMA_VIOLATION`, message de l'erreur originale pour `PARSE_ERROR`

> **Note** : l'ancien type `NO_JSON_FOUND` est fusionné dans `INVALID_JSON`. Le LLM devant retourner uniquement du JSON, l'absence de JSON et le JSON malformé se réduisent au même cas : `JSON.parse()` échoue. Le champ `rawOutput` permet de distinguer les deux situations au debug si nécessaire.

```typescript
type ExtractionErrorType = 'INVALID_JSON' | 'SCHEMA_VIOLATION' | 'PARSE_ERROR';

class ExtractionFatalError extends Error {
  type: ExtractionErrorType;
  rawOutput: string;
  contractId: string;
  details?: string;

  constructor(type: ExtractionErrorType, rawOutput: string, contractId: string, details?: string) {
    super(`Extraction failed [${type}] for contract ${contractId}${details ? `: ${details}` : ''}`);
    this.name = 'ExtractionFatalError';
    this.type = type;
    this.rawOutput = rawOutput;
    this.contractId = contractId;
    this.details = details;
  }
}
```

### Erreurs exportées

Le package exporte deux types d'erreurs **d'extraction** :

| Erreur | Cause | Signification |
|---|---|---|
| `TemplateInterpolationError` | Variable manquante dans le dictionnaire | Bug du code appelant — contrat ou appel mal configuré |
| `ExtractionFatalError` | `JSON.parse` échoue, schema invalide, ou `parse()` throw | Bug en amont — prompt agent défaillant ou LLM défaillant |

### Erreurs non-extraction (propagées telles quelles)

Certaines erreurs ne relèvent pas de l'extraction LLM et ne sont **pas wrappées** par le package. Elles propagent directement à l'appelant :

| Source | Type d'erreur | Cause | Signification |
|---|---|---|---|
| `agentResponse` vide | `TypeError` | String vide passée en premier argument | Bug du code appelant — l'agent en amont n'a rien retourné |
| `LLMClient.complete()` | Dépend du provider | Réseau, timeout, rate limit, erreur API | Infrastructure — hors scope du package |
| `contract.maxTokens` invalide | `TypeError` | Valeur non-entière ou ≤ 0 | Bug du code appelant — contrat mal configuré |
| `outputSchema(variables)` throw | Dépend du consommateur | Reason inconnue, bug dans le schema builder | Bug du code appelant — factory de schema défaillante |
| Compilation Ajv du schema | `Error` (Ajv) | Schema malformé, keyword inconnu avec `strict: true` | Bug du code appelant — schema défectueux |

> **Règle normative** : le `StructuredExtractor` ne **wrappe** jamais les erreurs du `LLMClient`, les `TypeError` de validation de config, ni les erreurs du `outputSchema` dynamique dans un `ExtractionFatalError` ou autre type d'erreur. Ces erreurs propagent à l'appelant **identiques** à leur forme originale. Le `try/catch` de logging (voir "Implémentation du logging de sortie" ci-dessus) observe et re-throw — il ne transforme rien. L'appelant qui veut un catch exhaustif doit gérer : `TemplateInterpolationError`, `ExtractionFatalError`, et les erreurs natives de son `LLMClient`.

### Exports du package

Le package exporte exactement les symboles suivants depuis son point d'entrée (`index.ts`) :

```typescript
// Classe principale
export { StructuredExtractor } from './extractor';

// Interfaces & types
export type { ExtractionContract } from './contract';
export type { LLMClient } from './llm-client';
export type { ExtractionErrorType } from './errors';
export type { JSONSchema } from './schema';

// Erreurs
export { ExtractionFatalError } from './errors';
export { TemplateInterpolationError } from './errors';
```

Rien d'autre n'est exporté. Les fonctions internes (`interpolate`, `PLACEHOLDER_REGEX`, l'instance Ajv) sont privées au package. Les consommateurs n'ont accès qu'aux symboles listés ci-dessus.

> **Structure de fichiers** : les chemins d'import dans la liste d'exports (`./extractor`, `./contract`, etc.) sont **illustratifs, pas normatifs**. L'implémenteur peut organiser le code comme il le souhaite (un fichier par composant, tout dans un seul fichier, etc.) tant que les exports publics depuis `index.ts` sont exactement ceux listés ci-dessus.

---

## Consommateurs actuels

Le package est consommé par deux produits indépendants :

| Produit | Description | Contrats |
|---|---|---|
| **SN-Engine** | Moteur du cycle de vie des spécifications normatives (`generate`, `review`) | C1–C5 |
| **Markdown Structural Normalizer** | Outil standalone de restructuration et nettoyage de documents Markdown | C6 |

Chaque produit définit ses propres contrats. Le `StructuredExtractor` ne sait rien de SN-Engine ni du Normalizer — il exécute le contrat qu'on lui donne.

> **Convention pour les variables** : le dictionnaire de variables passé à `extract()` est `Record<string, string>`. Les consommateurs doivent convertir les valeurs non-string avant l'appel : `{ start_line: String(span.start_line), end_line: String(span.end_line) }`. Le package ne fait aucune coercion.

---

## Stratégie de test

Le package est testé avec **Vitest**. Le `LLMClient` est **toujours mocké** — aucun appel LLM réel en test.

### Mock LLMClient

```typescript
function mockLLMClient(response: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}
```

Le mock retourne une string fixe. Pour tester les erreurs, utiliser `mockRejectedValue`.

### Couverture attendue

| Composant | Ce qu'on teste |
|---|---|
| `interpolate()` | Happy path, variable manquante → `TemplateInterpolationError`, variables excédentaires ignorées, placeholders sans espaces, regex edge cases |
| `extract()` flux complet | Happy path (JSON valide, schema OK, parse OK → T), clone défensif (dict original non muté), injection `agent_response` (écrase si déjà présent) |
| `extract()` erreurs | `INVALID_JSON` (réponse non-JSON, markdown wrappé), `SCHEMA_VIOLATION` (champ manquant, type incorrect, enum hors range), `PARSE_ERROR` (invariant croisé échoue dans parse), `TypeError` sur maxTokens invalide, `TypeError` sur agentResponse vide (`''`) et whitespace-only (`'  \n  '`) |
| Schema dynamique | Fonction appelée avec variables post-injection, schema varie correctement par input |
| Logging | `vi.spyOn(console, 'error')` — vérifier format JSON one-line, présence de `contractId` et `sourceAgent` |

> **Logging en test** : le logging `console.error` est observé via `vi.spyOn(console, 'error')` et vérifié dans les assertions. Le spy est reset dans `afterEach`. Le package n'expose pas de logger injectable — le spy standard suffit.

### Fixtures recommandées

Chaque test d'`extract()` fournit un contrat inline (pas d'import de vrais contrats C1–C6 — ceux-ci appartiennent aux consommateurs). Les fixtures sont des paires `{ llmResponse: string, expectedResult: T }` ou `{ llmResponse: string, expectedError: ExtractionErrorType }`.

### Tests normatifs obligatoires

Les tests suivants sont **normatifs** — leur absence est une violation de la spec. Ils couvrent des vecteurs de triche silencieux (implémentations qui passent les tests basiques mais échouent en conditions réelles).

| Test | Ce qu'il vérifie | Vecteur de triche bloqué |
|---|---|---|
| **Interpolation avec `$` dans agentResponse** | Passer une `agentResponse` contenant `"Price: $100 (regex: $1 back-ref $& match)"` et vérifier que le template interpolé contient ces caractères **littéralement**, sans interprétation regex | Utilisation de `String.replace(regex, string)` au lieu de `String.replace(regex, function)` |
| **`temperature: 0` dans l'appel LLM** | Spy sur `llmClient.complete` et asserter que le troisième argument contient `{ temperature: 0, maxTokens: ... }` | Hardcoder une temperature différente |
| **Ordre `extract_start` avant toute validation** | Vérifier que `console.error` est appelé (avec `event: 'extract_start'`) **avant** toute autre opération (validation, interpolation, `llmClient.complete`). Garantit le pairing `extract_start`/`extract_end` même si une étape précoce throw | Loguer `extract_start` après la validation ou après l'appel LLM |
| **`removeSchema` appelé pour schema dynamique** | Avec un contrat dont `outputSchema` est une fonction : spy sur `ajv.removeSchema` et vérifier qu'il est appelé **une fois** avec la référence du schema résolu. Avec un contrat statique : vérifier que `removeSchema` n'est **pas** appelé | Omettre `removeSchema` (fuite mémoire silencieuse) |
| **`removeSchema` même en cas d'erreur schema** | Avec un schema dynamique et une réponse JSON valide qui échoue la validation schema (→ `SCHEMA_VIOLATION`) : vérifier que `removeSchema` est quand même appelé (via `finally`). Avec un JSON invalide (→ `INVALID_JSON`, avant compile) : vérifier que `removeSchema` n'est **pas** appelé (le schema n'a jamais été compilé) | `removeSchema` dans le happy path uniquement, ou appel sur un schema jamais compilé |
| **agentResponse whitespace-only** | Passer `"   \n  "` et vérifier `TypeError('agentResponse must be a non-empty string')` | Validation `=== ''` stricte qui laisse passer le whitespace |


---

## Résumé des types (exportés par le package)

| Type                         | Champs clés                                      |
| ---------------------------- | ------------------------------------------------ |
| `ExtractionContract<T>`      | `id`, `sourceAgent`, `contextDescription`, `extractionPrompt`, `outputSchema`, `maxTokens?`, `parse()` |
| `LLMClient`                  | `complete(system, user, config)` |
| `ExtractionFatalError`       | `type` (`INVALID_JSON \| SCHEMA_VIOLATION \| PARSE_ERROR`), `rawOutput`, `contractId`, `details?` |
| `TemplateInterpolationError` | `variableName`, `contractId`, `templateField` |
