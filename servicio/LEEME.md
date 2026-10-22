# Servicio de guardado

Misma arquitectura que «Actividades Relevantes CACOM 5» (`Herramientas/Cuenta regresiva/servicio`).
La página (`index.html`) es un solo archivo estático; este servicio es lo único
que escribe, y no maneja ninguna credencial.

```
   navegador ──▶ nginx ──▶ servicio ──▶ data/estancias.json  +  commit en git
                   │                          ▲
                   └── sirve el mismo archivo ┘
```

Contrato: `GET /api/estancias` → `{ sha, data }`; `POST` con `{ sha, autor, data }`.
Si el `sha` ya no es el vigente responde `409` con la versión nueva y la página
une los dos trabajos y reintenta. Si dos estancias quedarían en la misma cama
al mismo tiempo responde `422`.

## Montarlo

Requisitos: Node 18+, nginx, git.

```bash
sudo mkdir -p /var/www/barracas-transeuntes
sudo chown -R www-data:www-data /var/www/barracas-transeuntes
sudo -u www-data git -C /var/www/barracas-transeuntes init -b main
sudo -u www-data git -C /var/www/barracas-transeuntes config user.name  "Barracas Transeúntes"
sudo -u www-data git -C /var/www/barracas-transeuntes config user.email "barracas@cacom5.local"

# desde el equipo de trabajo
rsync -az --exclude='data/' --exclude='.git/' --exclude='servicio/' ./ USUARIO@SERVIDOR:/var/www/barracas-transeuntes/
rsync -az ./servicio/ USUARIO@SERVIDOR:/opt/barracas-transeuntes/servicio/

# en el servidor
sudo cp /opt/barracas-transeuntes/servicio/despliegue/barracas-transeuntes.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now barracas-transeuntes
sudo cp /opt/barracas-transeuntes/servicio/despliegue/nginx-barracas-transeuntes.conf /etc/nginx/sites-available/barracas-transeuntes
sudo sed -i 's/DOMINIO/el.subdominio.asignado/g' /etc/nginx/sites-available/barracas-transeuntes
sudo ln -s /etc/nginx/sites-available/barracas-transeuntes /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`data/` **nunca** se sube con rsync: lo escribe el servidor. El archivo se crea
solo con el primer registro.

Probar: `curl https://DOMINIO/api/estancias` debe devolver `{"sha":…,"data":…}`.
Luego registrar un ingreso: abajo a la derecha debe decir «Guardado en el servidor».

## Ajustes (variables de entorno en la unidad de systemd)

| Variable | Por defecto | Para qué |
|---|---|---|
| `RAIZ` | `/var/www/barracas-transeuntes` | Carpeta que sirve nginx y que es el repositorio |
| `PUERTO` | `8788` | Donde escucha (8787 es de la cuenta regresiva) |
| `ESCUCHA` | `127.0.0.1` | Solo local. No cambiar |
| `GIT_AUTOR` / `GIT_CORREO` | Barracas Transeúntes | Firma de los commits |
| `ORIGEN` | *(vacío)* | Solo si la página se sirve desde otro dominio |

## Lo que hay que tener presente

- **Datos personales.** El archivo guarda nombres e identificaciones. No se
  sube a ningún repositorio externo (`.gitignore` lo bloquea) ni se sincroniza
  de vuelta a GitLab. Los mensajes de commit no llevan nombres.
- **Quien tenga el enlace puede editar**, igual que en la cuenta regresiva.
  Aquí pesa más por tratarse de datos personales: conviene publicarlo solo en
  la intranet o cerrarlo con una clave compartida (unas diez líneas en el
  servicio) o con `auth_basic` en nginx.
- Apagar la edición es una línea: `SYNC_URL = ""` en `index.html`.
