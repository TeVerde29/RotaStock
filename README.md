# RotaStock — Control de Rotación de Inventario con FIFO Estricto

> Aplicación de escritorio portable (Electron) para registrar compras y ventas, valorar el inventario con FIFO estricto (PEPS) y diagnosticar la rotación de cada producto en un período de análisis configurable.

<p align="center">
  <img src="https://img.shields.io/badge/Estado-Activo-0f9488?style=for-the-badge" alt="Estado: activo">
  <img src="https://img.shields.io/badge/JavaScript-Vanilla-f5b942?style=for-the-badge&logo=javascript&logoColor=111827" alt="JavaScript Vanilla">
  <img src="https://img.shields.io/badge/Escritorio-Electron_30-47848F?style=for-the-badge&logo=electron&logoColor=ffffff" alt="Electron 30">
  <img src="https://img.shields.io/badge/Costeo-FIFO_(PEPS)-2563eb?style=for-the-badge" alt="FIFO / PEPS">
  <img src="https://img.shields.io/badge/Tipo-App_Portable-334155?style=for-the-badge" alt="Aplicación Portable">
  <img src="https://img.shields.io/badge/Licencia-MIT-64748b?style=for-the-badge" alt="Licencia MIT">
</p>

---

## Tabla de contenidos

- [Descripción](#descripción)
- [Características principales](#características-principales)
- [Stack tecnológico](#stack-tecnológico)
- [Arquitectura](#arquitectura)
- [Modelado FIFO y métricas de rotación](#modelado-fifo-y-métricas-de-rotación)
- [Instalación y uso](#instalación-y-uso)
- [Requisitos del sistema](#requisitos-del-sistema)
- [Persistencia y copias de seguridad](#persistencia-y-copias-de-seguridad)
- [Buenas prácticas de uso](#buenas-prácticas-de-uso)
- [Roadmap](#roadmap)
- [Licencia](#licencia)
- [Autor](#autor)

---

## Descripción

El control de rotación de inventario es una de las palancas más sensibles de la logística de almacén: un producto que no se mueve inmoviliza capital, ocupa espacio y se deteriora; un producto que rota demasiado rápido sin cobertura suficiente genera quiebres de stock. Medir esa dinámica exige, además, una política de costeo coherente: si el costo de lo vendido no refleja el orden real de ingreso de los lotes, los indicadores de rotación, cobertura y ganancia bruta se vuelven incomparables entre períodos.

**RotaStock** registra productos y movimientos de compra y venta; su motor reconstruye, desde cero y en orden cronológico, los lotes vivos, el stock, el COGS, los ingresos y la ganancia bruta. Sobre ese estado derivado calcula, para el período elegido en la cabecera (de una semana a todo el historial), los días de inventario, la rotación en veces, los días de cobertura y los días sin movimiento, y semaforiza cada producto en **Rotación Sana, Lenta, Muy Lenta o Inventario Dormido**.

A diferencia de una hoja de cálculo, el sistema **no almacena indicadores precalculados como fuente de verdad**. Cualquier alta, edición o baja de un movimiento dispara un *replay* completo: el stock, el COGS de cada venta y las alertas se recalculan a partir de la bitácora. Esa decisión de diseño elimina la deriva entre "lo que muestra el dashboard" y "lo que ocurrió en el almacén", y hace auditable cada cifra.

---

## Características principales

- **Dashboard de rotación** con 5 KPIs (días de inventario, COGS, ingresos, ganancia bruta, alertas) y gráficos (barras de ingresos vs. COGS, dona de estados) mediante Chart.js.
- **CRUD de productos** con stock inicial opcional registrado como compra FIFO, búsqueda, filtro por estado y orden por 7 campos.
- **Registro de movimientos** (compras y ventas) con autocompletado de producto, validación de stock disponible y recálculo automático del COGS.
- **Motor de replay FIFO estricto (PEPS)**: cada venta consume el lote más antiguo disponible; el costeo no es editable desde la interfaz, evitando series mezcladas.
- **Semaforización por inactividad**: cuatro estados (Sana / Lenta / Muy Lenta / Dormido) según días sin movimiento, con umbrales configurables.
- **Período de análisis flexible**: 7, 15, 30, 90, 180, 365 días o todo el historial — recorta los flujos analizados, nunca los lotes.
- **Exportación a Excel de tres hojas** (Resumen, Productos, Movimientos) acotada al período activo, generada 100% en el cliente con SheetJS.
- **Persistencia local con backups automáticos**: escribe `inventario.json` junto al ejecutable y genera copias fechadas cada 60 s como máximo.
- **Seguro por diseño**: `contextIsolation` activo y `nodeIntegration` desactivado; el renderer no accede al sistema de archivos, solo a un puente IPC de dos métodos (`db:load` / `db:save`).
- **100% offline en operación**: sin conexión a internet, sin backend, sin base de datos externa.
- **Tema claro/oscuro** persistido y aplicado antes del primer pintado para evitar parpadeo.
- **Modo navegador**: el frontend también corre fuera de Electron usando `localStorage` como respaldo.

---

## Stack tecnológico

| Capa | Tecnología | Función |
|---|---|---|
| Escritorio | Electron 30 + electron-builder | Ventana nativa y empaquetado en `.exe` portable |
| IPC | `preload.js` + `contextBridge` | Puente seguro de carga y guardado de la base JSON |
| Presentación | HTML5 + CSS3 (claro/oscuro) | SPA de cinco vistas |
| Motor de negocio | JavaScript Vanilla (`Engine`) | Replay FIFO y cálculo de métricas de rotación |
| Visualización | Chart.js 4 (vendorizado, sin CDN) | Barras y dona del dashboard |
| Exportación | SheetJS / xlsx (vendorizado, sin CDN) | Reporte Excel de tres hojas, sin servidor |
| Persistencia | `inventario.json` + `backups/` | Fuente de verdad local, offline |

No se utilizan frameworks de componentes ni bundlers. El objeto `Engine` (en `frontend/script.js`) encapsula todo el motor de replay FIFO y el cálculo de métricas, sin dependencias externas más allá de Chart.js y SheetJS.

---

## Arquitectura

RotaStock está diseñado como una **aplicación de escritorio offline**, empaquetable en un único ejecutable portable de Windows (`RotaStock.exe`). El frontend es una SPA de HTML5/CSS/JavaScript Vanilla que también puede abrirse en el navegador, usando `localStorage` como respaldo cuando no hay proceso Electron.

```
RotaStock/
 ├── main.js              # Proceso principal: rutas portables, carga/guardado JSON, backups, ventana
 ├── preload.js            # Puente IPC seguro (contextBridge): isElectron, loadDB, saveDB
 ├── package.json
 ├── frontend/
 │    ├── index.html
 │    ├── style.css
 │    ├── script.js        # Motor Engine: replay FIFO, métricas, render de las 5 vistas
 │    └── assets/vendor/    # Chart.js y SheetJS vendorizados (sin CDN)
 ├── datos/
 │    └── inventario.json  # Base de datos local: productos, movimientos, umbrales
 └── backups/
      └── inventario-<ISO>.json   # Copias automáticas, máximo una por minuto
```

En el `.exe` empaquetado, el frontend se sirve desde el `app.asar` (solo lectura) y los archivos JSON se escriben junto al ejecutable, no dentro del asar. `getBasePath()` distingue ambos modos mediante `app.isPackaged`.

---

## Modelado FIFO y métricas de rotación

El núcleo no es un solver numérico: es un **reloj de almacén**. Se ordenan los movimientos por fecha, se recorren uno a uno y se mantiene, por producto, una cola de lotes `{ remaining, costo, fecha }` — la implementación literal de PEPS.

**Compra** de `q` unidades a costo unitario `c`: se agrega un lote a la cola; `COGS_compra = q·c` (costo de adquisición, no de ventas).

**Venta** de `q` unidades a precio `p`: se consumen lotes desde el más antiguo hasta cubrir `q`; `COGS_venta = Σ take_k · costo_k` y `Ganancia = Ingreso − COGS`.

A partir de ese estado derivado, para un período `[t₀, t₁]`:

- **Rotación (veces)** = COGS / Inventario promedio
- **Cobertura (días)** = Valor de inventario final / (COGS diario)
- **Días de inventario** (KPI principal) = Valor de inventario actual total / (COGS total del período / días)

La **semaforización** por inactividad es independiente de la rotación en veces: un producto puede tener rotación alta en el período y, aun así, estar **Dormido** si lleva más días sin movimiento que el umbral configurado. Esa doble lectura —velocidad histórica vs. silencio reciente— es deliberada, y es la que dispara la alerta de capital inmovilizado.

> La memoria descriptiva completa del proyecto —con la formulación matemática detallada del replay FIFO, los indicadores y el esquema de persistencia— está disponible en [`/docs/Memoria_Descriptiva_RotaStock.pdf`](./docs).

---

## Instalación y uso

### Modo desarrollo

```bash
# Clonar el repositorio
git clone https://github.com/TeVerde29/RotaStock.git
cd RotaStock

# Instalar dependencias
npm install

# Ejecutar en modo desarrollo (ventana Electron)
npm start
```

### Empaquetar el ejecutable portable

```bash
npm run build
# Genera dist/RotaStock.exe — copiable a un USB, sin instalador
```

### Flujo básico de uso

1. **Registrar un producto** (con stock inicial opcional como primera compra FIFO).
2. **Registrar movimientos** de compra y venta desde la vista Movimientos.
3. **Consultar el dashboard** de Rotación: KPIs, gráficos y detalle por producto.
4. **Ajustar umbrales** de semaforización en Configuración si el ritmo del almacén lo requiere.
5. **Exportar a Excel** el reporte de tres hojas para el período activo.

---

## Requisitos del sistema

| Componente | Requisito mínimo |
|---|---|
| Procesador | Intel Core i3 o equivalente |
| Memoria RAM | 4 GB (8 GB recomendados para el empaquetado Electron) |
| Pantalla | 1024×640 px mínimo; diseño pensado para 1360×860 |
| Sistema operativo | Windows 10 o superior para el `.exe` portable; el frontend también corre en navegador |
| Runtime de desarrollo | Node.js LTS (`npm install`, `npm start`, `npm run build`) |
| Conectividad | Ninguna en operación. Internet solo para la instalación inicial de dependencias |

---

## Persistencia y copias de seguridad

- Fuente de verdad: `datos/inventario.json` (`{ meta, config, productos, movimientos }`). Si no existe, se crea con umbrales por defecto (Sana = 7, Lenta = 15, Muy Lenta = 30 días).
- Cada guardado exitoso genera, si pasaron más de 60 s desde el último backup, una copia fechada en `backups/`.
- Un fallo de lectura no bloquea el arranque: cae a una base por defecto (`defaultDB()`).
- En navegador (sin Electron), la persistencia usa `localStorage` (clave `rotastock_db`), con `datos/inventario.json` como semilla inicial.

---

## Buenas prácticas de uso

- Registrar primero el producto y después sus movimientos — una venta sin stock disponible se rechaza; no se permiten saldos negativos.
- El costo de una compra es el de adquisición; el "costo" de una venta es el precio de venta — el COGS lo calcula el motor FIFO, no el operador.
- Ajustar los umbrales de semaforización según el tipo de almacén: un almacén de movimiento lento (repuestos) necesita umbrales más holgados que uno de consumo diario.
- Elegir el período según la pregunta: 7 días para rupturas recientes, 90–365 para rotación estructural, "Siempre" para el retrato histórico completo.
- Mantener el ejecutable en una carpeta escribible — si `datos/` queda dentro de un directorio de solo lectura, el guardado falla silenciosamente.
- No editar `inventario.json` a mano salvo necesidad estricta: los backups permiten recuperar un estado reciente ante cualquier error.

---

## Roadmap

- [ ] Empaquetado multiplataforma (macOS / Linux)
- [ ] Soporte para múltiples almacenes/ubicaciones
- [ ] Historial de cambios de umbrales
- [ ] Tests automatizados del motor de replay FIFO

---

## Licencia

Este proyecto se distribuye bajo la licencia **MIT**. Consulta el archivo [`LICENSE`](./LICENSE) para más detalles.

---

## Autor

**Pedro Giovanni Ricra Figueroa**
Estudiante de Ingeniería de Sistemas — Universidad Nacional de Ucayali

- GitHub: [@TeVerde29](https://github.com/TeVerde29)
- LinkedIn: [Pedro Giovanni Ricra Figueroa](http://www.linkedin.com/in/pedro-giovanni-ricra-figueroa-971a20433)
- Email: pedro.ricra.figueroa@gmail.com

---

<div align="center">

Si este proyecto te resultó útil, considera darle una estrella en GitHub.

</div>
