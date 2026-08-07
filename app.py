# app.py
import streamlit as st
from streamlit_folium import st_folium
import folium
import json
from pathlib import Path

st.set_page_config(
    page_title="Goyder's Line Explorer",
    page_icon="🌾",
    layout="wide",
)

st.title("Goyder's Line – South Australia")
st.caption("Stage 0 · Official DEW line")

# ---------- load GeoJSON ----------
@st.cache_data
def load_geojson():
    path = Path("goyders_line_4326.geojson")
    if not path.exists():
        st.error("goyders_line_4326.geojson not found.")
        st.stop()
    with open(path) as f:
        return json.load(f)

geojson_data = load_geojson()

# ---------- sidebar ----------
with st.sidebar:
    st.header("Layers")
    show_line = st.checkbox("Goyder's Line", value=True)

    st.markdown("---")
    st.subheader("George Woodroffe Goyder")
    
    # Portrait
    img_path = Path("assets/george_goyder.jpg")
    if img_path.exists():
        st.image(
            str(img_path),
            caption="George Woodroffe Goyder (1820–1898)",
            use_container_width=True,
        )
    else:
        st.info("Portrait image not found in assets/")

    st.caption(
        "Source: State Library of South Australia, B 496"
    )
    
    st.markdown(
        """
        Surveyor-General of South Australia who, in 1865, 
        mapped the approximate northern limit of reliable 
        rainfall for cropping (~250–300 mm isohyet).
        """
    )

# ---------- map ----------
m = folium.Map(
    location=[-33.5, 137.5],
    zoom_start=6,
    tiles="CartoDB positron",
    control_scale=True,
)

folium.TileLayer("OpenStreetMap", name="OpenStreetMap").add_to(m)
folium.TileLayer(
    tiles="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attr="Esri",
    name="Satellite",
).add_to(m)

if show_line:
    folium.GeoJson(
        geojson_data,
        name="Goyder's Line",
        style_function=lambda x: {
            "color": "#8B0000",
            "weight": 4,
            "opacity": 0.95,
        },
        tooltip=folium.GeoJsonTooltip(
            fields=["OBJECTID"],
            aliases=["Segment"],
            sticky=True,
        ),
        highlight_function=lambda x: {"weight": 6, "color": "#FF4500"},
    ).add_to(m)

folium.LayerControl(collapsed=False).add_to(m)

st_folium(m, width=None, height=720, returned_objects=[])

st.markdown("---")
st.caption(
    "Goyder's Line approximates the northern limit of reliable cropping rainfall "
    "as assessed by Surveyor-General George Goyder in 1865."
)
