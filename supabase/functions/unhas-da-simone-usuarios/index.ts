import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PERMISSION_KEYS = [
  'agenda',
  'agendamento_manual',
  'bloqueios',
  'expediente',
  'servicos',
  'profissionais',
  'cupons',
  'vip',
  'clientes',
  'pacotes',
  'recorrencias',
  'feriados',
  'configuracoes',
  'integracoes',
];

const VALID_ROLES = ['MASTER', 'GERENTE', 'RECEPCAO', 'PROFISSIONAL', 'PERSONALIZADO'];

function result(ok, data, code = undefined) {
  return new Response(JSON.stringify({ ok, ...data, ...(code ? { code } : {}) }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function fail(message, code) {
  console.error('[unhas-da-simone-usuarios]', code || 'ERROR', message);
  return result(false, { error: message }, code || 'ERROR');
}

function cleanPermissions(value) {
  const source = value && typeof value === 'object' ? value : {};
  const output = {};
  for (const key of PERMISSION_KEYS) output[key] = source[key] === true;
  return output;
}

function getAdminKey() {
  const directNames = [
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SECRET_API_KEY',
  ];

  for (const name of directNames) {
    const value = Deno.env.get(name);
    if (value && value.trim()) return value.trim();
  }

  const grouped = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (grouped && grouped.trim()) {
    const raw = grouped.trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.default === 'string' && parsed.default.trim()) return parsed.default.trim();
        for (const value of Object.values(parsed)) {
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
      }
    } catch (_) {
      // Algumas instalações podem armazenar uma única chave diretamente.
      if (raw.startsWith('sb_secret_') || raw.startsWith('eyJ')) return raw;
    }
  }

  return null;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return fail('Método não permitido.', 'METHOD_NOT_ALLOWED');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const adminKey = getAdminKey();
    if (!supabaseUrl) return fail('A variável SUPABASE_URL não está configurada na função.', 'MISSING_SUPABASE_URL');
    if (!adminKey) {
      return fail(
        'A chave administrativa não está disponível na função. Configure SUPABASE_SECRET_KEY nos Secrets da Edge Function ou mantenha SUPABASE_SERVICE_ROLE_KEY.',
        'MISSING_ADMIN_KEY',
      );
    }

    const authorization = req.headers.get('Authorization') || '';
    const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
    const accessToken = tokenMatch ? tokenMatch[1].trim() : '';
    if (!accessToken) return fail('Sua sessão não foi enviada. Saia do painel e entre novamente.', 'MISSING_SESSION');

    // Valida o usuário com a chave pública enviada pelo próprio cliente.
    const publicKey = req.headers.get('apikey')
      || Deno.env.get('SUPABASE_ANON_KEY')
      || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
    if (!publicKey) return fail('A chave pública do projeto não foi recebida pela função.', 'MISSING_PUBLIC_KEY');

    const userClient = createClient(supabaseUrl, publicKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    const actor = userData && userData.user;
    if (userError || !actor) return fail('Sessão inválida ou expirada. Entre novamente no painel.', 'INVALID_SESSION');

    // Cliente administrativo usado somente no servidor; a chave nunca vai ao navegador.
    const admin = createClient(supabaseUrl, adminKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: actorProfile, error: actorProfileError } = await admin
      .from('administradores')
      .select('usuario_id, perfil, ativo')
      .eq('usuario_id', actor.id)
      .maybeSingle();

    if (actorProfileError) {
      return fail(`Não foi possível consultar o perfil MASTER: ${actorProfileError.message}`, 'MASTER_PROFILE_QUERY_FAILED');
    }

    const actorRole = String((actorProfile && actorProfile.perfil) || '').trim().toUpperCase();
    const actorActive = actorProfile && (actorProfile.ativo === true || String(actorProfile.ativo).toLowerCase() === 'true');
    if (!actorProfile || !actorActive || actorRole !== 'MASTER') {
      return fail('Este acesso não está cadastrado como MASTER ativo. Confira o perfil do usuário na equipe.', 'MASTER_REQUIRED');
    }

    let body;
    try {
      body = await req.json();
    } catch (_) {
      return fail('Os dados enviados pelo formulário são inválidos.', 'INVALID_BODY');
    }

    const action = String(body.action || '').trim().toLowerCase();
    const targetId = String(body.id || '').trim();

    if (action === 'create') {
      const nome = String(body.nome || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const perfil = String(body.perfil || 'RECEPCAO').trim().toUpperCase();
      const permissoes = cleanPermissions(body.permissoes);
      const profissionalId = body.profissional_id ? String(body.profissional_id) : null;

      if (nome.length < 2 || nome.length > 100) return fail('Informe um nome válido.', 'INVALID_NAME');
      if (!validEmail(email)) return fail('Informe um e-mail válido.', 'INVALID_EMAIL');
      if (password.length < 8) return fail('A senha inicial precisa ter pelo menos 8 caracteres.', 'INVALID_PASSWORD');
      if (!VALID_ROLES.includes(perfil)) return fail('Perfil de acesso inválido.', 'INVALID_ROLE');
      if (perfil === 'PROFISSIONAL' && !profissionalId) return fail('Selecione o profissional vinculado ao acesso.', 'PROFESSIONAL_REQUIRED');

      if (perfil === 'MASTER') {
        for (const key of PERMISSION_KEYS) permissoes[key] = true;
      } else if (!Object.values(permissoes).some((enabled) => enabled === true)) {
        return fail('Marque pelo menos uma permissão para este colaborador.', 'PERMISSION_REQUIRED');
      }

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: nome, full_name: nome },
      });

      if (createError || !created || !created.user) {
        return fail((createError && createError.message) || 'Não foi possível criar a conta de autenticação.', 'AUTH_CREATE_FAILED');
      }

      const { error: profileError } = await admin.from('administradores').insert({
        usuario_id: created.user.id,
        nome,
        email,
        perfil,
        permissoes,
        ativo: true,
        profissional_id: profissionalId,
      });

      if (profileError) {
        await admin.auth.admin.deleteUser(created.user.id);
        return fail(`A conta foi criada, mas o perfil não pôde ser salvo: ${profileError.message}`, 'PROFILE_CREATE_FAILED');
      }

      return result(true, { id: created.user.id, message: 'Colaborador criado com sucesso.' });
    }

    if (action === 'update') {
      if (!targetId) return fail('Colaborador não identificado.', 'TARGET_REQUIRED');

      const { data: target, error: targetError } = await admin
        .from('administradores')
        .select('usuario_id,nome,email,perfil,permissoes,ativo,profissional_id')
        .eq('usuario_id', targetId)
        .maybeSingle();

      if (targetError) return fail(`Não foi possível consultar o colaborador: ${targetError.message}`, 'TARGET_QUERY_FAILED');
      if (!target) return fail('Colaborador não encontrado.', 'TARGET_NOT_FOUND');

      const nome = body.nome === undefined ? target.nome : String(body.nome).trim();
      const email = body.email === undefined ? target.email : String(body.email).trim().toLowerCase();
      const perfil = body.perfil === undefined ? target.perfil : String(body.perfil).trim().toUpperCase();
      const ativo = body.ativo === undefined ? target.ativo : body.ativo === true;
      const permissoes = body.permissoes === undefined ? cleanPermissions(target.permissoes) : cleanPermissions(body.permissoes);
      const profissionalId = body.profissional_id === undefined
        ? target.profissional_id
        : (body.profissional_id ? String(body.profissional_id) : null);
      const password = body.password === undefined ? '' : String(body.password);

      if (nome.length < 2 || nome.length > 100) return fail('Informe um nome válido.', 'INVALID_NAME');
      if (!validEmail(email)) return fail('Informe um e-mail válido.', 'INVALID_EMAIL');
      if (!VALID_ROLES.includes(perfil)) return fail('Perfil de acesso inválido.', 'INVALID_ROLE');
      if (password && password.length < 8) return fail('A nova senha precisa ter pelo menos 8 caracteres.', 'INVALID_PASSWORD');
      if (perfil === 'PROFISSIONAL' && !profissionalId) return fail('Selecione o profissional vinculado ao acesso.', 'PROFESSIONAL_REQUIRED');

      if (perfil === 'MASTER') {
        for (const key of PERMISSION_KEYS) permissoes[key] = true;
      } else if (!Object.values(permissoes).some((enabled) => enabled === true)) {
        return fail('Marque pelo menos uma permissão para este colaborador.', 'PERMISSION_REQUIRED');
      }

      const removingMaster = String(target.perfil || '').toUpperCase() === 'MASTER'
        && (perfil !== 'MASTER' || !ativo);
      if (removingMaster) {
        const { count, error: countError } = await admin
          .from('administradores')
          .select('usuario_id', { count: 'exact', head: true })
          .eq('perfil', 'MASTER')
          .eq('ativo', true);
        if (countError) return fail(`Não foi possível conferir os MASTER ativos: ${countError.message}`, 'MASTER_COUNT_FAILED');
        if ((count || 0) <= 1) return fail('O sistema precisa manter pelo menos um MASTER ativo.', 'LAST_MASTER');
      }

      if (targetId === actor.id && (!ativo || perfil !== 'MASTER')) {
        return fail('Não é permitido bloquear ou retirar o perfil MASTER do próprio acesso.', 'SELF_PROTECTION');
      }

      const authUpdate: any = { user_metadata: { name: nome, full_name: nome } };
      if (email !== target.email) {
        authUpdate.email = email;
        authUpdate.email_confirm = true;
      }
      if (password) authUpdate.password = password;

      const { error: authUpdateError } = await admin.auth.admin.updateUserById(targetId, authUpdate);
      if (authUpdateError) return fail(`Não foi possível atualizar a conta: ${authUpdateError.message}`, 'AUTH_UPDATE_FAILED');

      const { error: profileUpdateError } = await admin.from('administradores').update({
        nome,
        email,
        perfil,
        permissoes,
        ativo,
        profissional_id: profissionalId,
        atualizado_em: new Date().toISOString(),
      }).eq('usuario_id', targetId);

      if (profileUpdateError) return fail(`A conta foi atualizada, mas o perfil não: ${profileUpdateError.message}`, 'PROFILE_UPDATE_FAILED');
      return result(true, { message: 'Colaborador atualizado com sucesso.' });
    }

    if (action === 'delete') {
      if (!targetId) return fail('Colaborador não identificado.', 'TARGET_REQUIRED');
      if (targetId === actor.id) return fail('Você não pode excluir o próprio acesso enquanto está conectado.', 'SELF_DELETE');

      const { data: target, error: targetError } = await admin
        .from('administradores')
        .select('usuario_id,nome,email,perfil,permissoes,ativo,profissional_id')
        .eq('usuario_id', targetId)
        .maybeSingle();

      if (targetError) return fail(`Não foi possível consultar o colaborador: ${targetError.message}`, 'TARGET_QUERY_FAILED');
      if (!target) return fail('Colaborador não encontrado.', 'TARGET_NOT_FOUND');

      if (String(target.perfil || '').toUpperCase() === 'MASTER' && target.ativo === true) {
        const { count, error: countError } = await admin
          .from('administradores')
          .select('usuario_id', { count: 'exact', head: true })
          .eq('perfil', 'MASTER')
          .eq('ativo', true);
        if (countError) return fail(`Não foi possível conferir os MASTER ativos: ${countError.message}`, 'MASTER_COUNT_FAILED');
        if ((count || 0) <= 1) return fail('Não é possível excluir o último MASTER ativo.', 'LAST_MASTER');
      }

      const { error: profileDeleteError } = await admin.from('administradores').delete().eq('usuario_id', targetId);
      if (profileDeleteError) return fail(`Não foi possível remover o perfil: ${profileDeleteError.message}`, 'PROFILE_DELETE_FAILED');

      const { error: authDeleteError } = await admin.auth.admin.deleteUser(targetId);
      if (authDeleteError) {
        await admin.from('administradores').insert(target);
        return fail(`Não foi possível excluir a conta de autenticação: ${authDeleteError.message}`, 'AUTH_DELETE_FAILED');
      }

      return result(true, { message: 'Colaborador excluído com sucesso.' });
    }

    return fail('Ação não reconhecida.', 'UNKNOWN_ACTION');
  } catch (error) {
    const message = error && error.message ? error.message : 'Erro inesperado na função de usuários.';
    return fail(message, 'UNHANDLED_ERROR');
  }
});
