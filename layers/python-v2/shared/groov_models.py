"""Shared Pydantic v2 validation models for the V2 sensor-submission payloads.

Replaces the hand-rolled Joi-emulating validators that were previously
duplicated (~600 lines) across addNewSensorV2/addNewSensor.py and
insertFormV2/insertForm.py. This module is deployed via the shared `python-v2`
Lambda layer: CI copies it into the layer's `python/` dir, which Lambda
extracts to /opt/python (already on sys.path), so `import groov_models`
resolves at runtime for any function that attaches PythonV2Layer.

Two payload validators are exported because the two endpoints intentionally
differ (each mirrors its own original Joi schema):

                          addNewSensor              insertForm
  unknown keys            allowed (extra=ignore)    rejected (extra=forbid)
  sensor.mechanism        optional (+ '', null)     required
  ligand/…/doi            any non-empty string      must match DOI pattern
  protein.accession=null  rejected                  allowed (skipped)
  stimulus arrays         optional, no min          min 1 item each
  >=1 stimulus group      not required              required (Joi `.or`)
  top-level extra keys    allowed; PK/SK/uuid typed rejected; only sensor/user/timeSubmit

Parity target: PASS/FAIL parity with the deployed validators (the handler
tests assert only statusCode and body.type == 'Validation Error'; they do not
assert on message text). Notes:
  * abortEarly:false  -> Pydantic collects every error by default.
  * regex_engine='python-re' makes pattern checks use Python's `re`, so they
    behave exactly as the previous `re.compile(...)` ports (not the Rust engine).
  * Joi rejects '' for a required string unless `.allow('')`, so required
    string fields carry min_length=1.
  * Optional-not-null fields default to None and are typed to accept null,
    matching the ports' leniency (they skip `is not None`); the one exception
    is addNewSensor's accession, whose port explicitly rejects an explicit null.
"""

from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, create_model, model_validator

# ---- Shared patterns & enums (single source of truth for both endpoints) ----

REF_FIGURE_PATTERN = r"^(Figure|Supplementary Figure|Table|Supplementary Table) [S]?[1-9]?[0-9A-Za-z]?$"
DOI_PATTERN = r"(?i)^(https?://doi\.org/|doi:|doi\.org/)?(10\.\d{4,9}[-._;()/:A-Z0-9]+)$"
ALIAS_PATTERN = r"^[A-Za-z0-9_.]+$"
UNIPROT_PATTERN = r"^[A-Za-z0-9_]+$"
SEQUENCE_PATTERN = r"^[ATCGatcg]+$"
# `*` (not `+`) so the empty string passes too — the Joi equivalent of
# `.pattern("^[A-Za-z0-9_.]+$").allow('')`.
ACCESSION_PATTERN = r"^[A-Za-z0-9_.]*$"

LIGAND_METHODS = (
    "EMSA", "DNase footprinting", "Isothermal titration calorimetry",
    "Synthetic regulation", "Fluorescence polarization", "Surface plasmon resonance",
    "Thermal shift", "Spectrophotometric competition", "Spectral shift",
    "DNA affinity chromatography", "Autophosphorylation assay",
)
OPERATOR_METHODS = (
    "EMSA", "DNase footprinting", "Crystal structure", "Isothermal titration calorimetry",
    "Fluorescence polarization", "Surface plasmon resonance", "Synthetic regulation", "ChIP-Seq",
)
MECHANISMS = ("Apo-repressor", "Apo-activator", "Co-repressor", "Co-activator", "Signal transduction")
FAMILIES = ("TetR", "LysR", "AraC", "MarR", "LacI", "GntR", "LuxR", "IclR", "Other", "OmpR", "HisKA")
REGULATORY_EFFECTS = ("activates", "represses")
REF_TYPES = ("UniProt", "groovDB")
# OmpR/HisKA proteins only exist as part of a two-component system, so a
# single-protein submission can't use them (enforced on the sensor below).
TWO_COMPONENT_ONLY_FAMILIES = {"OmpR", "HisKA"}

_STIM_KEYS = ("ligands", "operators", "light_stimuli", "temperature_stimuli")

# ---- Reusable leaf types ----------------------------------------------------

RefFigure = Annotated[str, StringConstraints(pattern=REF_FIGURE_PATTERN)]
RegulatoryEffect = Optional[Literal[REGULATORY_EFFECTS + ("",)]]
Sequence = Annotated[str, StringConstraints(min_length=1, max_length=512, pattern=SEQUENCE_PATTERN)]


def _make_payload_model(
    *,
    extra,
    doi_type,
    accession_type,
    stim_min_length,
    mechanism_required,
    require_stim_group,
    include_admin_fields,
):
    """Build a top-level payload model for one endpoint's profile.

    The parameters are exactly the points where the two endpoints' Joi schemas
    diverge (see the table in the module docstring); everything else is shared.
    """
    cfg = ConfigDict(extra=extra, regex_engine="python-re")

    class Ligand(BaseModel):
        model_config = cfg
        doi: doi_type
        method: Literal[LIGAND_METHODS]
        ref_figure: RefFigure
        name: Annotated[str, StringConstraints(min_length=1, max_length=64)]
        SMILES: Annotated[str, StringConstraints(min_length=1)]
        regulatory_effect: RegulatoryEffect = None
        kd: Optional[float] = None

    class Operator(BaseModel):
        model_config = cfg
        doi: doi_type
        method: Literal[OPERATOR_METHODS]
        ref_figure: RefFigure
        sequence: Sequence
        kd: Optional[float] = None

    class LightStimulus(BaseModel):
        model_config = cfg
        wavelength: float
        regulatory_effect: RegulatoryEffect = None
        doi: doi_type
        method: Annotated[str, StringConstraints(min_length=1)]
        ref_figure: RefFigure

    class TemperatureStimulus(BaseModel):
        model_config = cfg
        temperature: float
        regulatory_effect: RegulatoryEffect = None
        doi: doi_type
        method: Annotated[str, StringConstraints(min_length=1)]
        ref_figure: RefFigure

    class MutationEntry(BaseModel):
        model_config = cfg
        mutations: Annotated[list[Annotated[str, StringConstraints(max_length=32)]], Field(min_length=1)]
        ref_type: Literal[REF_TYPES]
        ref_id: Annotated[str, StringConstraints(min_length=1, max_length=64)]

    class Protein(BaseModel):
        model_config = cfg
        alias: Annotated[str, StringConstraints(min_length=1, max_length=16, pattern=ALIAS_PATTERN)]
        uniProtID: Annotated[str, StringConstraints(min_length=1, pattern=UNIPROT_PATTERN)]
        accession: accession_type = None
        family: Literal[FAMILIES]
        ligands: Optional[list[Ligand]] = Field(default=None, min_length=stim_min_length)
        operators: Optional[list[Operator]] = Field(default=None, min_length=stim_min_length)
        light_stimuli: Optional[list[LightStimulus]] = Field(default=None, min_length=stim_min_length)
        temperature_stimuli: Optional[list[TemperatureStimulus]] = Field(default=None, min_length=stim_min_length)
        mutations: Optional[list[MutationEntry]] = None

        if require_stim_group:
            @model_validator(mode="after")
            def _require_one_stimulus_group(self):
                # Joi `.or('ligands','operators','light_stimuli','temperature_stimuli')`
                # — presence of the key counts (even if null), matching the port.
                if not (self.model_fields_set & set(_STIM_KEYS)):
                    raise ValueError(
                        f"must contain at least one of {list(_STIM_KEYS)}"
                    )
                return self

    mechanism_type = Literal[MECHANISMS] if mechanism_required else Optional[Literal[MECHANISMS + ("",)]]
    mechanism_default = ... if mechanism_required else None  # Ellipsis => required

    class Sensor(BaseModel):
        model_config = cfg
        mechanism: mechanism_type = mechanism_default
        about: Optional[Annotated[str, StringConstraints(max_length=500)]] = None
        proteins: Annotated[list[Protein], Field(min_length=1)]

        @model_validator(mode="after")
        def _two_component_family_check(self):
            families = {p.family for p in self.proteins}
            if (families & TWO_COMPONENT_ONLY_FAMILIES) and len(self.proteins) < 2:
                raise ValueError(
                    "OmpR and HisKA families are only valid for two-component systems (2 or more proteins)"
                )
            return self

    fields = {
        "sensor": (Sensor, ...),
        "user": (Optional[str], None),
        "timeSubmit": (Optional[float], None),
    }
    if include_admin_fields:
        fields["submissionUUID"] = (Optional[str], None)
        fields["PK"] = (Optional[str], None)
        fields["SK"] = (Optional[str], None)

    return create_model("Payload", __config__=cfg, **fields)


# addNewSensorV2: lenient outer shape (allowUnknown), optional mechanism, plain
# DOI strings, no stimulus minimums, but an explicit-null accession is rejected.
ADD_NEW_SENSOR_PAYLOAD = _make_payload_model(
    extra="ignore",
    doi_type=Annotated[str, StringConstraints(min_length=1)],
    accession_type=Annotated[str, StringConstraints(pattern=ACCESSION_PATTERN)],
    stim_min_length=None,
    mechanism_required=False,
    require_stim_group=False,
    include_admin_fields=True,
)

# insertFormV2: strict outer shape (no unknown keys), required mechanism,
# DOI-pattern-checked references, >=1 non-empty stimulus group per protein.
INSERT_FORM_PAYLOAD = _make_payload_model(
    extra="forbid",
    doi_type=Annotated[str, StringConstraints(pattern=DOI_PATTERN)],
    accession_type=Optional[Annotated[str, StringConstraints(pattern=ACCESSION_PATTERN)]],
    stim_min_length=1,
    mechanism_required=True,
    require_stim_group=True,
    include_admin_fields=False,
)


def validate(model, data):
    """Validate `data` against `model`; return a list of error strings.

    Empty list == valid. Preserves the old validators' return contract so the
    handlers keep doing `errors = validate_main_schema(data)`. Like Joi's
    abortEarly:false, every failure is collected; each is flattened to
    "path: message".
    """
    try:
        model.model_validate(data)
        return []
    except ValidationError as exc:
        errors = []
        for err in exc.errors():
            loc = ".".join(str(part) for part in err["loc"])
            errors.append(f"{loc}: {err['msg']}" if loc else err["msg"])
        return errors
