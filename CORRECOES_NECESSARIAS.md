# Correções Necessárias - PR #191

## 🔴 Bloqueante - `cost-reconcile.sh` linha 28

### Problema:
O arquivo `cost-reconcile.sh` ainda contém o host antigo hardcoded:
```bash
API="http://100.99.46.3:3100/api"   # host morto, ignora PAPERCLIP_API_URL
```

### Solução (mesmo padrão usado 3x nesta PR):
Substituir linha 28 por:
```bash
_BASE="${PAPERCLIP_API_URL:-http://100.100.20.5:3100}"
_BASE="${_BASE%/}"; _BASE="${_BASE%/api}"
API="${_BASE}/api"
```

### Por que isso importa:
- O `cost-cron.sh:30` invoca `cost-reconcile.sh --apply`
- A PR consertou o gate de reachability mas não o worker
- Antes: falha visível (logava "Paperclip unreachable")
- Depois: falha invisível (executa mas produz zero events)
- A PR reivindica que "cost-event reconciliation is silently dead" está fixado - mas não está

## 🟡 Não-bloqueante - `cost-action-dryrun.sh` linha 64

### Problema:
GNU date não-portável (mesmo bug C):
```bash
date -d "$(date +%Y-%m-01) +1 month -1 day" +%-d
```

### Solução:
Substituir por versão portável (igual ao fix do bug C já aplicado):
```bash
# Calcular último dia do mês de forma portável
current_year=$(date +%Y)
current_month=$(date +%m)
# Usar cal para pegar último dia do mês
last_day=$(cal "$current_month" "$current_year" | awk 'NF {D=$NF}; END{print D}')
```

## Passos para Executar as Correções:

1. **Checkout do branch da PR #191:**
   ```bash
   git fetch origin
   git checkout <branch-da-pr-191>
   ```

2. **Aplicar correção bloqueante:**
   ```bash
   # Editar scripts/cost-reconcile.sh linha 28
   ```

3. **Aplicar correção não-bloqueante (opcional):**
   ```bash
   # Editar scripts/cost-action-dryrun.sh linha 64
   ```

4. **Commit:**
   ```bash
   git add scripts/cost-reconcile.sh scripts/cost-action-dryrun.sh
   git commit -m "Fix: Apply reviewer feedback

   - cost-reconcile.sh: Replace hardcoded API URL with PAPERCLIP_API_URL pattern
   - cost-action-dryrun.sh: Replace GNU date with portable version

   Addresses blocking finding from PR review.
   Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
   ```

5. **Push:**
   ```bash
   git push origin <branch-da-pr-191>
   ```

6. **Comentar na PR:**
   ```bash
   gh pr comment 191 --body "Ajustes aplicados:

   - Fix applied to cost-reconcile.sh:28 (blocking) - replaced hardcoded dead host with PAPERCLIP_API_URL pattern
   - Fix applied to cost-action-dryrun.sh:64 (non-blocking) - replaced GNU date with portable version

   Using same PAPERCLIP_API_URL handling pattern already applied 3× in this PR."
   ```

## Resumo dos Arquivos Modificados:

1. `scripts/cost-reconcile.sh` - Linha 28 (BLOQUEANTE)
2. `scripts/cost-action-dryrun.sh` - Linha 64 (não-bloqueante, mas recomendado)

## Validação:

Após aplicar as correções, validar com:
```bash
# Check syntax
bash -n scripts/cost-reconcile.sh
bash -n scripts/cost-action-dryrun.sh

# Verify API URL pattern
grep -n "PAPERCLIP_API_URL" scripts/cost-reconcile.sh
```

Nota: O repositório moklabs/moklabs não está acessível através do token atual. As instruções acima fornecem os passos exatos para aplicar as correções quando o acesso estiver disponível.