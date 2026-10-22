// Guardado de las estancias de las barracas de transeúntes.
//
// Misma arquitectura que el servicio de «Actividades Relevantes CACOM 5»: el
// archivo vive en el disco de este servidor —el mismo que sirve nginx— y cada
// guardado deja un commit en un repositorio git local. No hay credenciales.
//
// Contrato con la página:
//
//   GET   ->  { sha, data }        la versión vigente del archivo
//   POST  ->  { sha, autor, data } guarda, si nadie cambió el archivo antes
//
// El POST lleva el `sha` sobre el que se hicieron los cambios. Si en el
// entretanto otra persona guardó, se responde 409 con la versión nueva: la
// página une los dos trabajos y vuelve a intentar.
//
// Diferencia con el de actividades: aquí dos estancias no pueden ocupar la
// misma cama al mismo tiempo. La página ya lo evita, pero con la edición
// abierta el servicio no lo da por hecho y rechaza (422) lo que lo incumpla.

import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";

const correr = promisify(execFile);

// ---------------------------------------------------------------- ajustes

const RAIZ = process.env.RAIZ || "/var/www/barracas-transeuntes";
const RUTA = "data/estancias.json";
const ARCHIVO = join(RAIZ, RUTA);

const PUERTO = Number(process.env.PUERTO || 8788);
// Solo escucha en local: quien entra de internet pasa por nginx, nunca aquí.
const ESCUCHA = process.env.ESCUCHA || "127.0.0.1";

const GIT_AUTOR = process.env.GIT_AUTOR || "Barracas Transeúntes";
const GIT_CORREO = process.env.GIT_CORREO || "barracas@localhost";

// Solo hace falta si la página se sirve desde otro dominio.
const ORIGEN = process.env.ORIGEN || "";

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 3000;
const MAX_HIST = 40;

const VACIO = { v: 1, entries: [], historial: [] };

// ---------------------------------------------------------------- la cola
//
// Un solo proceso con concurrencia de verdad: dos guardados a la vez leerían
// el mismo archivo y el segundo pisaría al primero. La cola serializa
// leer-comparar-escribir.

let cola = Promise.resolve();

function enCola(tarea) {
  const siguiente = cola.then(tarea, tarea);
  cola = siguiente.then(() => {}, () => {});
  return siguiente;
}

// ---------------------------------------------------------------- el archivo

async function leerDisco() {
  let texto;
  try {
    texto = await readFile(ARCHIVO, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { sha: null, data: VACIO };
    throw e;
  }
  let data;
  try {
    data = JSON.parse(texto);
  } catch (e) {
    const err = new Error("El archivo del sitio no es un JSON legible");
    err.estado = 502;
    throw err;
  }
  return { sha: sha256(texto), data };
}

// Temporal y renombrado: nginx nunca sirve el archivo a medio escribir.
async function escribirDisco(texto) {
  const tmp = ARCHIVO + ".tmp";
  await mkdir(dirname(ARCHIVO), { recursive: true });
  await writeFile(tmp, texto, "utf8");
  await rename(tmp, ARCHIVO);
}

// Si el repositorio no está montado, el guardado NO falla: se anota y ya.
async function commit(mensaje) {
  try {
    await correr("git", ["-C", RAIZ, "add", "--", RUTA]);
    await correr("git", ["-C", RAIZ, "commit", "-m", mensaje], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: GIT_AUTOR,
        GIT_AUTHOR_EMAIL: GIT_CORREO,
        GIT_COMMITTER_NAME: GIT_AUTOR,
        GIT_COMMITTER_EMAIL: GIT_CORREO
      }
    });
    const { stdout } = await correr("git", ["-C", RAIZ, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch (e) {
    const salida = String((e && (e.stdout || e.stderr)) || e);
    if (/nothing to commit|nada para hacer commit/i.test(salida)) return null;
    console.error("[aviso] no se pudo dejar el commit:", salida.slice(0, 300));
    return null;
  }
}

// ---------------------------------------------------------------- lectura

async function leer() {
  const { sha, data } = await leerDisco();
  return { estado: 200, cuerpo: { sha, data } };
}

// ---------------------------------------------------------------- escritura

async function guardar(crudo) {
  let cuerpo;
  try { cuerpo = JSON.parse(crudo); }
  catch (e) { return { estado: 400, cuerpo: { error: "El cuerpo del pedido no es JSON" } }; }

  const limpio = revisar(cuerpo && cuerpo.data);
  if (!limpio) return { estado: 400, cuerpo: { error: "La información no tiene la forma esperada" } };

  const { sha: shaActual, data: dataActual } = await leerDisco();
  const shaEnviado = (cuerpo && typeof cuerpo.sha === "string") ? cuerpo.sha : null;
  if (shaActual !== shaEnviado) {
    return { estado: 409, cuerpo: { conflicto: true, sha: shaActual, data: dataActual } };
  }

  const choque = cruce(limpio.entries);
  if (choque) {
    return { estado: 422, cuerpo: { error: `La cama ${choque} quedaría con dos estancias a la vez` } };
  }

  const autor = String((cuerpo && cuerpo.autor) || "").trim().slice(0, 40);
  const texto = JSON.stringify(limpio, null, 2) + "\n";

  await escribirDisco(texto);
  const hecho = await commit(mensajeCommit(autor, limpio));

  return { estado: 200, cuerpo: { sha: sha256(texto), commit: hecho } };
}

// El mensaje del commit no lleva nombres ni identificaciones: el historial de
// git se copia y se comparte con más facilidad que el archivo.
function mensajeCommit(autor, data) {
  const n = data.entries.length;
  const ultimo = data.historial && data.historial[0];
  const quien = autor || (ultimo && ultimo.quien) || "alguien";
  const verbo = { ingreso: "registra un ingreso", salida: "registra una salida",
                  editar: "corrige una estancia", borrar: "elimina una estancia" };
  const qué = (ultimo && verbo[ultimo.accion]) || "actualiza las estancias";
  const dónde = ultimo && ultimo.cama ? ` en ${ultimo.cama}` : "";
  return `${qué}${dónde} (${n} ${n === 1 ? "registro" : "registros"}) — ${quien}`;
}

// ---------------------------------------------------------------- revisión

const FECHA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CAMA = /^[0-9A-Za-z ]{1,16}\|\d{1,2}$/;

// Se queda solo con los campos conocidos y recorta lo que sobre. Con la
// edición abierta a cualquiera con el enlace, es la única defensa real.
function revisar(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) return null;
  if (data.entries.length > MAX_ENTRIES) return null;

  const texto = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

  const entries = [];
  const ids = new Set();
  for (const e of data.entries) {
    if (!e || typeof e !== "object") return null;
    const ing = String(e.ing || "");
    const sal = e.sal == null || e.sal === "" ? null : String(e.sal);
    if (!FECHA_HORA.test(ing)) return null;
    if (sal !== null && (!FECHA_HORA.test(sal) || sal <= ing)) return null;
    if (!CAMA.test(String(e.bed || ""))) return null;
    const nom = texto(e.nom, 120);
    if (!nom) return null;
    const id = texto(e.id, 40) || ("e" + Math.random().toString(36).slice(2, 11));
    if (ids.has(id)) return null;
    ids.add(id);
    const pers = e.pers === 2 ? 2 : 1;
    entries.push({
      id,
      nom,
      ide: texto(e.ide, 30),
      gra: texto(e.gra, 40),
      dep: texto(e.dep, 80),
      bed: String(e.bed),
      ing,
      sal,
      pers,
      aco: pers === 2 ? texto(e.aco, 120) : "",
      obs: texto(e.obs, 400)
    });
  }

  const historial = (Array.isArray(data.historial) ? data.historial : [])
    .slice(0, MAX_HIST)
    .filter((h) => h && typeof h === "object" && !isNaN(Date.parse(h.ts)))
    .map((h) => ({
      ts: new Date(h.ts).toISOString(),
      quien: texto(h.quien, 60),
      accion: texto(h.accion, 24),
      nom: texto(h.nom, 120),
      cama: texto(h.cama, 40)
    }));

  return { v: 1, actualizado: new Date().toISOString(), entries, historial };
}

// Devuelve la cama con dos estancias superpuestas, o null. Las fechas van en
// formato fijo AAAA-MM-DDTHH:MM, así que se comparan como texto.
function cruce(entries) {
  const porCama = new Map();
  for (const e of entries) {
    if (!porCama.has(e.bed)) porCama.set(e.bed, []);
    porCama.get(e.bed).push(e);
  }
  for (const [cama, lista] of porCama) {
    lista.sort((a, b) => (a.ing < b.ing ? -1 : a.ing > b.ing ? 1 : 0));
    for (let i = 1; i < lista.length; i++) {
      const prev = lista[i - 1];
      if (prev.sal === null || lista[i].ing < prev.sal) return cama.replace(/\|(\d+)$/, (_, n) => ` (cama ${Number(n) + 1})`);
    }
  }
  return null;
}

// ---------------------------------------------------------------- auxiliares

function sha256(txt) {
  return createHash("sha256").update(txt, "utf8").digest("hex");
}

function cabeceras() {
  const base = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (!ORIGEN) return base;
  return Object.assign(base, {
    "Access-Control-Allow-Origin": ORIGEN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  });
}

function responder(res, estado, cuerpo) {
  res.writeHead(estado, cabeceras());
  res.end(JSON.stringify(cuerpo));
}

function leerCuerpo(req) {
  return new Promise((listo, falla) => {
    let total = 0;
    const partes = [];
    req.on("data", (trozo) => {
      total += trozo.length;
      if (total > MAX_BYTES) {
        falla(Object.assign(new Error("demasiado grande"), { estado: 413 }));
        req.destroy();
        return;
      }
      partes.push(trozo);
    });
    req.on("end", () => listo(Buffer.concat(partes).toString("utf8")));
    req.on("error", falla);
  });
}

// ---------------------------------------------------------------- el servidor

const servidor = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cabeceras());
      res.end();
      return;
    }

    if (req.method === "GET") {
      const r = await enCola(leer);
      responder(res, r.estado, r.cuerpo);
      return;
    }

    if (req.method === "POST") {
      let crudo;
      try {
        crudo = await leerCuerpo(req);
      } catch (e) {
        if (e && e.estado === 413) {
          responder(res, 413, { error: "La información recibida es demasiado grande" });
          return;
        }
        throw e;
      }
      const r = await enCola(() => guardar(crudo));
      responder(res, r.estado, r.cuerpo);
      return;
    }

    responder(res, 405, { error: "Solo se admiten GET y POST" });
  } catch (e) {
    const estado = (e && e.estado) || 502;
    responder(res, estado, { error: String(e && e.message ? e.message : e) });
  }
});

servidor.listen(PUERTO, ESCUCHA, () => {
  console.log(`Servicio de guardado escuchando en ${ESCUCHA}:${PUERTO}`);
  console.log(`Archivo: ${ARCHIVO}`);
});
